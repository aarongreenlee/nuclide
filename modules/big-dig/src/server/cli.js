'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.parseArgsAndRunMain = parseArgsAndRunMain;

var _log4js;

function _load_log4js() {
  return _log4js = _interopRequireDefault(require('log4js'));
}

var _nuclideUri;

function _load_nuclideUri() {
  return _nuclideUri = _interopRequireDefault(require('../../../nuclide-commons/nuclideUri'));
}

var _os = _interopRequireDefault(require('os'));

var _username;

function _load_username() {
  return _username = require('../common/username');
}

var _main;

function _load_main() {
  return _main = require('./main');
}

var _ports;

function _load_ports() {
  return _ports = require('../common/ports');
}

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 *  strict-local
 * @format
 */

(_log4js || _load_log4js()).default.configure({
  appenders: [{
    type: 'file',
    filename: (_nuclideUri || _load_nuclideUri()).default.join(_os.default.tmpdir(), 'big-dig-cli.log')
  }, {
    type: 'console'
  }]
});

const DEFAULT_PORTS = '0';
const DEFAULT_TIMEOUT = 60000;

/**
 * @param absolutePathToServerMain The code that bootstraps the server will load the code at this
 *     path via require(). It is expected to have a default export that is a function that takes the
 *     WebSocket server created by Big Dig, along with other arguments, and starts the main
 *     server [that is using Big Dig as a building block].
 */
async function parseArgsAndRunMain(absolutePathToServerMain) {
  // All arguments expect for the last one are ignored.
  const params = JSON.parse(process.argv[process.argv.length - 1]);
  const {
    cname,
    expiration,
    exclusive,
    jsonOutputFile,
    caPath,
    serverCertPath,
    serverKeyPath
  } = params;
  let { ports, timeout } = params;
  if (cname != null && (typeof cname !== 'string' || cname.length === 0)) {
    throw new Error(`cname must be a non-empty string but was: '${cname}'`);
  }
  if (typeof jsonOutputFile !== 'string') {
    throw new Error('Must specify jsonOutputFile');
  }

  // port arg validation
  if (ports == null) {
    ports = DEFAULT_PORTS;
  }
  if (typeof ports !== 'string') {
    throw new Error(`ports must be specified as string but was: '${ports}'`);
  }
  // This will throw an exception if the ports string is invalid.
  (0, (_ports || _load_ports()).parsePorts)(ports);

  if (timeout == null) {
    timeout = DEFAULT_TIMEOUT;
  }
  if (typeof timeout !== 'number') {
    throw new Error(`timeout must be specified as number but was: '${timeout}'`);
  }

  // expiration arg validation
  if (typeof expiration !== 'string') {
    throw new Error(`expiration must be specified as string but was: '${expiration}'`);
  }
  const expirationMatch = expiration.match(/^(\d+)d$/);
  if (expirationMatch == null) {
    throw new Error(`expiration must be /(\\d+)d/ but was: '${expiration}'`);
  }
  const expirationDays = parseInt(expirationMatch[1], 10);
  if (expirationDays <= 0) {
    throw new Error(`expiration must be >0 but was ${expirationDays}`);
  }

  if (exclusive != null && (typeof exclusive !== 'string' || !exclusive.match(/^[\w\d][\w\d-]*$/))) {
    throw new Error(`exclusive must be a valid identifier: '${exclusive}'`);
  }

  let certificateStrategy;
  if (caPath != null || serverCertPath != null || serverKeyPath != null) {
    if (typeof caPath !== 'string' || typeof serverCertPath !== 'string' || typeof serverKeyPath !== 'string') {
      throw new Error('need either all or none of caPath, serverCertPath and serverKeyPath');
    }
    certificateStrategy = {
      type: 'reuse',
      paths: {
        caCert: caPath,
        serverCert: serverCertPath,
        serverKey: serverKeyPath
      }
    };
  } else {
    certificateStrategy = {
      type: 'generate',
      clientCommonName: 'nuclide',
      serverCommonName: cname != null ? cname : `${(0, (_username || _load_username()).getUsername)()}.nuclide.${_os.default.hostname()}`,
      openSSLConfigPath: require.resolve('./openssl.cnf')
    };
  }

  await (0, (_main || _load_main()).startServer)({
    certificateStrategy,
    ports,
    timeout,
    expirationDays,
    exclusive,
    jsonOutputFile,
    absolutePathToServerMain,
    serverParams: params.serverParams
  });
}