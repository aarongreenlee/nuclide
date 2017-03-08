'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.WORKSPACE_VIEW_URI = undefined;

var _reactForAtom = require('react-for-atom');

var _Webview;

function _load_Webview() {
  return _Webview = require('../../../nuclide-ui/Webview');
}

/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * 
 */

const WORKSPACE_VIEW_URI = exports.WORKSPACE_VIEW_URI = 'atom://nuclide/react-inspector';

class Inspector extends _reactForAtom.React.Component {
  constructor() {
    super();
    this._handleDidFinishLoad = this._handleDidFinishLoad.bind(this);
  }

  getTitle() {
    return 'React Inspector';
  }

  getDefaultLocation() {
    return 'pane';
  }

  getURI() {
    return WORKSPACE_VIEW_URI;
  }

  render() {
    return _reactForAtom.React.createElement((_Webview || _load_Webview()).Webview, {
      style: { width: '100%', height: '100%' },
      nodeintegration: true,
      className: 'native-key-bindings',
      onDidFinishLoad: this._handleDidFinishLoad,
      src: 'atom://nuclide/pkg/nuclide-react-inspector/lib/ui/inspector.html'
    });
  }

  _handleDidFinishLoad(event) {
    const element = event.target;
    const requirePaths = require.cache[__filename].paths;
    const inspectorDevTools = require.resolve('react-devtools-core/standalone');
    element.executeJavaScript(`initializeElementInspector(
        ${JSON.stringify(inspectorDevTools)},
        ${JSON.stringify(requirePaths)}
      );`);
  }
}
exports.default = Inspector;