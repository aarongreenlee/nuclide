'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {NuclideUri} from '../../remote-uri';
import type {HgRepositoryDescription} from '../../source-control-helpers';

import typeof * as FileWatcherServiceType from '../../filewatcher-base';

import invariant from 'assert';
import {trackEvent} from '../../analytics';
import ClientComponent from '../../server/lib/serviceframework/ClientComponent';
import RemoteDirectory from './RemoteDirectory';
import {loadServicesConfig} from '../../server/lib/serviceframework/config';
import {getProxy} from '../../service-parser';
import ServiceFramework from '../../server/lib/serviceframework';

const {CompositeDisposable, Disposable} = require('atom');
const remoteUri = require('../../remote-uri');
const logger = require('../../logging').getLogger();
const {EventEmitter} = require('events');

const RemoteFile = require('./RemoteFile');
const NuclideSocket = require('../../server/lib/NuclideSocket');
const {getConnectionConfig, setConnectionConfig} =
  require('./RemoteConnectionConfigurationManager');
const {getVersion} = require('../../version');

const newServices = ServiceFramework.loadServicesConfig();

const HEARTBEAT_AWAY_REPORT_COUNT = 3;
const HEARTBEAT_NOTIFICATION_ERROR = 1;
const HEARTBEAT_NOTIFICATION_WARNING = 2;

const FILE_WATCHER_SERVICE = 'FileWatcherService';
const FILE_SYSTEM_SERVICE = 'FileSystemService';

const CONNECTION_ALREADY_EXISTS = 'A connection already exists for the specified directory.';

type HeartbeatNotification = {
  notification: atom$Notification;
  code: string;
}

export type RemoteConnectionConfiguration = {
  host: string; // host nuclide server is running on.
  port: number; // port to connect to.
  cwd: string; // Path to remote directory user should start in upon connection.
  certificateAuthorityCertificate?: Buffer; // certificate of certificate authority.
  clientCertificate?: Buffer; // client certificate for https connection.
  clientKey?: Buffer; // key for https connection.
}

const _emitter: EventEmitter = new EventEmitter();

class RemoteConnection {
  _entries: {[path: string]: RemoteFile | RemoteDirectory};
  _config: RemoteConnectionConfiguration;
  _initialized: ?bool;
  _closed: ?bool;
  _subscriptions: CompositeDisposable;
  _hgRepositoryDescription: ?HgRepositoryDescription;
  _heartbeatNetworkAwayCount: number;
  _lastHeartbeatNotification: ?HeartbeatNotification;
  _client: ?ClientComponent;

  static _connections: Array<RemoteConnection> = [];

  constructor(config: RemoteConnectionConfiguration) {
    this._subscriptions = new CompositeDisposable();
    this._entries = {};
    this._config = config;
    this._heartbeatNetworkAwayCount = 0;
    this._closed = false;
  }

  dispose(): void {
    this._subscriptions.dispose();
  }

  static async _createInsecureConnectionForTesting(
    cwd: string,
    port: number,
  ): Promise<?RemoteConnection> {
    const config = {
      host: 'localhost',
      port,
      cwd,
    };
    const connection = new RemoteConnection(config);
    await connection.initialize();
    return connection;
  }

  /**
   * Create a connection by reusing the configuration of last successful connection associated with
   * given host. If the server's certs has been updated or there is no previous successful
   * connection, null (resolved by promise) is returned.
   */
  static async createConnectionBySavedConfig(
    host: string,
    cwd: string,
  ): Promise<?RemoteConnection> {
    const connectionConfig = getConnectionConfig(host);
    if (!connectionConfig) {
      return;
    }
    let connection;
    try {
      const config = {...connectionConfig, cwd};
      connection = new RemoteConnection(config);
      await connection.initialize();
      return connection;
    } catch (e) {
      if (e.message === CONNECTION_ALREADY_EXISTS) {
        invariant(connection);
        return RemoteConnection.getByHostnameAndPath(
          connection.getRemoteHostname(),
          connection.getPathForInitialWorkingDirectory(),
        );
      }
      logger.warn(`Failed to reuse connectionConfiguration for ${host}`, e);
      return null;
    }
  }

  // A workaround before Atom 2.0: Atom's Project::setPaths currently uses
  // ::repositoryForDirectorySync, so we need the repo information to already be
  // available when the new path is added. t6913624 tracks cleanup of this.
  async _setHgRepoInfo(): Promise<void> {
    const remotePath = this.getPathForInitialWorkingDirectory();
    const {getHgRepository} = this.getService('SourceControlService');
    this._setHgRepositoryDescription(await getHgRepository(remotePath));
  }

  _monitorConnectionHeartbeat() {
    const socket = this.getSocket();
    const serverUri = socket.getServerUri();

    /**
     * Adds an Atom notification for the detected heartbeat network status
     * The function makes sure not to add many notifications for the same event and prioritize
     * new events.
     */
    const addHeartbeatNotification = (
      type: number,
      errorCode: string,
      message: string,
      dismissable: boolean,
      askToReload: boolean
    ) => {
      const {code, notification: existingNotification} = this._lastHeartbeatNotification || {};
      if (code && code === errorCode && dismissable) {
        // A dismissible heartbeat notification with this code is already active.
        return;
      }
      let notification = null;
      const options = {dismissable, buttons: []};
      if (askToReload) {
        options.buttons.push({
          className: 'icon icon-zap',
          onDidClick() { atom.reload(); },
          text: 'Reload Atom',
        });
      }
      switch (type) {
        case HEARTBEAT_NOTIFICATION_ERROR:
          notification = atom.notifications.addError(message, options);
          break;
        case HEARTBEAT_NOTIFICATION_WARNING:
          notification = atom.notifications.addWarning(message, options);
          break;
        default:
          throw new Error('Unrecongnized heartbeat notification type');
      }
      if (existingNotification) {
        existingNotification.dismiss();
      }
      invariant(notification);
      this._lastHeartbeatNotification = {
        notification,
        code: errorCode,
      };
    };

    const onHeartbeat = () => {
      if (this._lastHeartbeatNotification) {
        // If there has been existing heartbeat error/warning,
        // that means connection has been lost and we shall show a message about connection
        // being restored without a reconnect prompt.
        const {notification} = this._lastHeartbeatNotification;
        notification.dismiss();
        atom.notifications.addSuccess('Connection restored to Nuclide Server at: ' + serverUri);
        this._heartbeatNetworkAwayCount = 0;
        this._lastHeartbeatNotification = null;
      }
    };

    const notifyNetworkAway = (code: string) => {
      this._heartbeatNetworkAwayCount++;
      if (this._heartbeatNetworkAwayCount >= HEARTBEAT_AWAY_REPORT_COUNT) {
        addHeartbeatNotification(HEARTBEAT_NOTIFICATION_WARNING, code,
          `Nuclide server can not be reached at "${serverUri}".<br/>` +
          'Check your network connection.',
          /*dismissable*/ true,
          /*askToReload*/ false);
      }
    };

    const onHeartbeatError = (error: any) => {
      const {code, message, originalCode} = error;
      trackEvent({
        type: 'heartbeat-error',
        data: {
          code: code || '',
          message: message || '',
          host: this._config.host,
        },
      });
      logger.info('Heartbeat network error:', code, originalCode, message);
      switch (code) {
        case 'NETWORK_AWAY':
            // Notify switching networks, disconnected, timeout, unreachable server or fragile
            // connection.
          notifyNetworkAway(code);
          break;
        case 'SERVER_CRASHED':
            // Server shut down or port no longer accessible.
            // Notify the server was there, but now gone.
          addHeartbeatNotification(HEARTBEAT_NOTIFICATION_ERROR, code,
                '**Nuclide Server Crashed**<br/>' +
                'Please reload Atom to restore your remote project connection.',
                /*dismissable*/ true,
                /*askToReload*/ true);
            // TODO(most) reconnect RemoteConnection, restore the current project state,
            // and finally change dismissable to false and type to 'WARNING'.
          break;
        case 'PORT_NOT_ACCESSIBLE':
            // Notify never heard a heartbeat from the server.
          const {port} = remoteUri.parse(serverUri);
          addHeartbeatNotification(HEARTBEAT_NOTIFICATION_ERROR, code,
                '**Nuclide Server Is Not Reachable**<br/>' +
                `It could be running on a port that is not accessible: ${port}.`,
                /*dismissable*/ true,
                /*askToReload*/ false);
          break;
        case 'INVALID_CERTIFICATE':
            // Notify the client certificate is not accepted by nuclide server
            // (certificate mismatch).
          addHeartbeatNotification(HEARTBEAT_NOTIFICATION_ERROR, code,
                '**Connection Reset Error**<br/>' +
                'This could be caused by the client certificate mismatching the ' +
                  'server certificate.<br/>' +
                'Please reload Atom to restore your remote project connection.',
                /*dismissable*/ true,
                /*askToReload*/ true);
            // TODO(most): reconnect RemoteConnection, restore the current project state.
            // and finally change dismissable to false and type to 'WARNING'.
          break;
        default:
          notifyNetworkAway(code);
          logger.error('Unrecongnized heartbeat error code: ' + code, message);
          break;
      }
    };
    socket.on('heartbeat', onHeartbeat);
    socket.on('heartbeat.error', onHeartbeatError);

    this._subscriptions.add(new Disposable(() => {
      socket.removeListener('heartbeat', onHeartbeat);
      socket.removeListener('heartbeat.error', onHeartbeatError);
    }));
  }

  getUriOfRemotePath(remotePath: string): string {
    return `nuclide://${this.getRemoteHost()}${remotePath}`;
  }

  getPathOfUri(uri: string): string {
    return remoteUri.parse(uri).path;
  }

  createDirectory(uri: string): RemoteDirectory {
    let {path} = remoteUri.parse(uri);
    path = require('path').normalize(path);

    let entry = this._entries[path];
    if (!entry || entry.getLocalPath() !== path) {
      this._entries[path] = entry = new RemoteDirectory(
        this,
        this.getUriOfRemotePath(path),
        {hgRepositoryDescription: this._hgRepositoryDescription}
      );
      // TODO: We should add the following line to keep the cache up-to-date.
      // We need to implement onDidRename and onDidDelete in RemoteDirectory
      // first. It's ok that we don't add the handlers for now since we have
      // the check `entry.getLocalPath() !== path` above.
      //
      // this._addHandlersForEntry(entry);
    }

    invariant(entry instanceof RemoteDirectory);
    if (!entry.isDirectory()) {
      throw new Error('Path is not a directory:' + uri);
    }

    return entry;
  }

  // A workaround before Atom 2.0: see ::getHgRepoInfo of main.js.
  _setHgRepositoryDescription(hgRepositoryDescription: ?HgRepositoryDescription): void {
    this._hgRepositoryDescription = hgRepositoryDescription;
  }

  createFile(uri: string): RemoteFile {
    let {path} = remoteUri.parse(uri);
    path = require('path').normalize(path);

    let entry = this._entries[path];
    if (!entry || entry.getLocalPath() !== path) {
      this._entries[path] = entry = new RemoteFile(this, this.getUriOfRemotePath(path));
      this._addHandlersForEntry(entry);
    }

    invariant(entry instanceof RemoteFile);
    if (entry.isDirectory()) {
      throw new Error('Path is not a file');
    }

    return entry;
  }

  _addHandlersForEntry(entry: RemoteFile | RemoteDirectory): void {
    const oldPath = entry.getLocalPath();
    /* $FlowFixMe */
    const renameSubscription = entry.onDidRename(() => {
      delete this._entries[oldPath];
      this._entries[entry.getLocalPath()] = entry;
    });
    /* $FlowFixMe */
    const deleteSubscription = entry.onDidDelete(() => {
      delete this._entries[entry.getLocalPath()];
      renameSubscription.dispose();
      deleteSubscription.dispose();
    });
  }

  async initialize(): Promise<void> {
    // Right now we don't re-handshake.
    if (this._initialized === undefined) {
      this._initialized = false;
      const client = this._getClient();

      // Test connection first. First time we get here we're checking to reestablish
      // connection using cached credentials. This will fail fast (faster than infoService)
      // when we don't have cached credentials yet.
      try {
        await client.testConnection();

        // Do version check.
        let serverVersion;

        // Need to set initialized to true optimistically so that we can get the InfoService.
        // TODO: We shouldn't need the client to get a service.
        this._initialized = true;
        const infoService = this.getService('InfoService');
        serverVersion = await infoService.getServerVersion();

        const clientVersion = getVersion();
        if (clientVersion !== serverVersion) {
          throw new Error(
            `Version mismatch. Client at ${clientVersion} while server at ${serverVersion}.`);
        }

        const FileSystemService = this.getService(FILE_SYSTEM_SERVICE);
        this._config.cwd = await FileSystemService.resolveRealPath(this._config.cwd);

        // Now that we know the real path, it's possible this collides with an existing connection.
        // If so, we should just stop immediately.
        if (RemoteConnection.getByHostnameAndPath(this._config.host, this._config.cwd) != null) {
          throw new Error(CONNECTION_ALREADY_EXISTS);
        }
      } catch (e) {
        client.close();
        this._initialized = false;
        throw e;
      }

      // Store the configuration for future usage.
      setConnectionConfig(this._config);

      this._monitorConnectionHeartbeat();

      // A workaround before Atom 2.0: see ::getHgRepoInfo.
      await this._setHgRepoInfo();

      // Register NuclideUri type conversions.
      client.registerType('NuclideUri',
        uri => this.getPathOfUri(uri), path => this.getUriOfRemotePath(path));

      // Save to cache.
      this._addConnection();
      this._watchRootProjectDirectory();
    }
  }

  _addConnection() {
    RemoteConnection._connections.push(this);
    _emitter.emit('did-add', this);
  }

  _watchRootProjectDirectory(): void {
    const rootDirectoryUri = this.getUriForInitialWorkingDirectory();
    const rootDirectotyPath = this.getPathForInitialWorkingDirectory();
    const FileWatcherService: FileWatcherServiceType = this.getService(FILE_WATCHER_SERVICE);
    invariant(FileWatcherService);
    const {watchDirectoryRecursive} = FileWatcherService;
    // Start watching the project for changes and initialize the root watcher
    // for next calls to `watchFile` and `watchDirectory`.
    const watchStream = watchDirectoryRecursive(rootDirectoryUri);
    const subscription = watchStream.subscribe(watchUpdate => {
      // Nothing needs to be done if the root directory was watched correctly.
      // Let's just console log it anyway.
      logger.info(`Watcher Features Initialized for project: ${rootDirectoryUri}`, watchUpdate);
    }, async error => {
      let warningMessageToUser = `You just connected to a remote project ` +
        `\`${rootDirectotyPath}\` but we recommend you remove this directory now ` +
        `because crucial features like synced remote file editing, file search, ` +
        `and Mercurial-related updates will not work.<br/>`;

      const loggedErrorMessage = error.message || error;
      logger.error(
        `Watcher failed to start - watcher features disabled! Error: ${loggedErrorMessage}`
      );

      const FileSystemService = this.getService(FILE_SYSTEM_SERVICE);
      if (await FileSystemService.isNfs(rootDirectotyPath)) {
        warningMessageToUser +=
          `This project directory: \`${rootDirectotyPath}\` is on <b>\`NFS\`</b> filesystem. ` +
          `Nuclide works best with local (non-NFS) root directory.` +
          `e.g. \`/data/users/$USER\``;
      } else {
        warningMessageToUser +=
          `<b><a href='https://facebook.github.io/watchman/'>Watchman</a> Error:</b>` +
          loggedErrorMessage;
      }
      // Add a persistent warning message to make sure the user sees it before dismissing.
      atom.notifications.addWarning(warningMessageToUser, {dismissable: true});
    }, () => {
      // Nothing needs to be done if the root directory watch has ended.
      logger.info(`Watcher Features Ended for project: ${rootDirectoryUri}`);
    });
    this._subscriptions.add(subscription);
  }

  close(): void {
    // Close the eventbus that will stop the heartbeat interval, websocket reconnect trials, ..etc.
    if (this._client) {
      this._client.close();
      this._client = null;
    }
    if (!this._closed) {
      // Future getClient calls should fail, if it has a cached RemoteConnection instance.
      this._closed = true;
      // Remove from _connections to not be considered in future connection queries.
      RemoteConnection._connections.splice(RemoteConnection._connections.indexOf(this), 1);
      _emitter.emit('did-close', this);
    }
  }

  getClient(): ClientComponent {
    if (!this._initialized) {
      throw new Error('Remote connection has not been initialized.');
    } else if (this._closed) {
      throw new Error('Remote connection has been closed.');
    } else {
      return this._getClient();
    }
  }

  _getClient(): ClientComponent {
    if (!this._client) {
      let uri;
      const options = {};

      // Use https if we have key, cert, and ca
      if (this._isSecure()) {
        options.certificateAuthorityCertificate = this._config.certificateAuthorityCertificate;
        options.clientCertificate = this._config.clientCertificate;
        options.clientKey = this._config.clientKey;
        uri = `https://${this.getRemoteHost()}`;
      } else {
        uri = `http://${this.getRemoteHost()}`;
      }

      // The remote connection and client are identified by both the remote host and the inital
      // working directory.
      const socket = new NuclideSocket(uri, options);
      this._client = new ClientComponent(socket, loadServicesConfig());
    }
    invariant(this._client);
    return this._client;
  }

  _isSecure(): boolean {
    return !!(
        this._config.certificateAuthorityCertificate
        && this._config.clientCertificate
        && this._config.clientKey
    );
  }

  getRemoteHost(): string {
    return `${this._config.host}:${this._config.port}`;
  }

  getPort(): number {
    return this._config.port;
  }

  getRemoteHostname(): string {
    return this._config.host;
  }

  getUriForInitialWorkingDirectory(): string {
    return this.getUriOfRemotePath(this.getPathForInitialWorkingDirectory());
  }

  getPathForInitialWorkingDirectory(): string {
    return this._config.cwd;
  }

  getConfig(): RemoteConnectionConfiguration {
    return this._config;
  }

  static onDidAddRemoteConnection(handler: (connection: RemoteConnection) => void): Disposable {
    _emitter.on('did-add', handler);
    return new Disposable(() => {
      _emitter.removeListener('did-add', handler);
    });
  }

  static onDidCloseRemoteConnection(handler: (connection: RemoteConnection) => void): Disposable {
    _emitter.on('did-close', handler);
    return new Disposable(() => {
      _emitter.removeListener('did-close', handler);
    });
  }

  static getForUri(uri: NuclideUri): ?RemoteConnection {
    const {hostname, path} = remoteUri.parse(uri);
    if (hostname == null) {
      return null;
    }
    return RemoteConnection.getByHostnameAndPath(hostname, path);
  }

  /**
   * Get cached connection match the hostname and the path has the prefix of connection.cwd.
   * @param hostname The connected server host name.
   * @param path The absolute path that's has the prefix of cwd of the connection.
   *   If path is null, empty or undefined, then return the connection which matches
   *   the hostname and ignore the initial working directory.
   */
  static getByHostnameAndPath(hostname: string, path: ?string): ?RemoteConnection {
    return RemoteConnection._connections.filter(connection => {
      return connection.getRemoteHostname() === hostname &&
          (!path || path.startsWith(connection.getPathForInitialWorkingDirectory()));
    })[0];
  }

  static getByHostname(hostname: string): Array<RemoteConnection> {
    return RemoteConnection._connections.filter(
      connection => connection.getRemoteHostname() === hostname,
    );
  }

  getService(serviceName: string): any {
    const [serviceConfig] = newServices.filter(config => config.name === serviceName);
    invariant(serviceConfig != null, `No config found for service ${serviceName}`);
    return getProxy(serviceConfig.name, serviceConfig.definition, this.getClient());
  }

  getSocket(): NuclideSocket {
    return this.getClient().getSocket();
  }
}

module.exports = {
  RemoteConnection,
  __test__: {
    connections: RemoteConnection._connections,
  },
};
