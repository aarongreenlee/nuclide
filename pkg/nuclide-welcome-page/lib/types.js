/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

export type WelcomePage = {
  topic: string,
  content: React$Node,
};

export type AppState = {
  welcomePages: Map<string, WelcomePage>,
  hiddenTopics: Set<string>,
  showAll: boolean,
  isWelcomePageVisible: boolean,
};

export type SerializedState = {
  hiddenTopics: Array<string>,
};

export type Store = {
  getState(): AppState,
  dispatch(action: Action): void,
  // subscribe isn't present in the version of Store provided to Epics
  // for some reason, uncommenting it (even making it optional) makes flow upset
  // subscribe(listener: () => mixed): () => void,
};

export type AddWelcomePageAction = {
  type: 'ADD_WELCOME_PAGE',
  payload: {
    welcomePage: WelcomePage,
  },
};

export type DeleteWelcomePageAction = {
  type: 'DELETE_WELCOME_PAGE',
  payload: {
    topic: string,
  },
};

export type UpdateWelcomePageVisibilityAction = {
  type: 'UPDATE_WELCOME_PAGE_VISIBILITY',
  payload: {
    isVisible: boolean,
  },
};

export type HideUnhideTopicsAction = {
  type: 'HIDE_UNHIDE_TOPICS',
  payload: {
    topicsToHide: Set<string>,
    topicsToUnhide: Set<string>,
  },
};

export type SetShowAllAction = {
  type: 'SET_SHOW_ALL',
  payload: {},
};

export type ClearShowAllAction = {
  type: 'CLEAR_SHOW_ALL',
  payload: {},
};

export type Action =
  | AddWelcomePageAction
  | DeleteWelcomePageAction
  | UpdateWelcomePageVisibilityAction
  | HideUnhideTopicsAction
  | SetShowAllAction
  | ClearShowAllAction;
