import {SchruteConn} from './schrute';
import {RAVEN_URL, RED, GREEN, GREY, BASE_URL, WORK_AVAILABLE_URL, DEFAULT_INTERVAL} from './constants';
import Raven from 'raven-js';

let timeout;

// Set polling interval in milliseconds (note, this is rate limted,
// so if you change agressively, it will error)
let checkForWorkInterval = DEFAULT_INTERVAL;

// Start disabled: require the tester to enable if they want to
// work when the browser starts
const appState = {
  tester_state: 'active',
  webSocketConnection: undefined,
  work_available_endpoint: WORK_AVAILABLE_URL,
  email: '',
  profileUrl: '',
  id: '',
  workTab: null,
  isPolling: false,
};

const notifications = {
  notLoggedIn: {
    iconUrl: 'icons/icon_notification.png',
    isClickable: true,
    type: 'basic',
    title: "You're not logged in",
    message: "You don't seem to be logged in to Rainforest, click here to go to your profile and log in.",
  },
};

function setupChromeEvents() {
  Raven.config(RAVEN_URL).install();
  const manifest = chrome.runtime.getManifest();
  appState.version = manifest.version;
  appState.profileUrl = `${BASE_URL}/profile?version=${manifest.version}`;

  chrome.notifications.onClicked.addListener(notificationId => {
    if (notificationId === 'not_logged_in') {
      makeNewSyncTab();
      chrome.notifications.clear('not_logged_in');
    }
  });

  // Load the initial id value from storage
  chrome.storage.sync.get('worker_uuid', data => {
    // Notify that we saved.
    if (data.worker_uuid !== undefined) {
      appState.uuid = data.worker_uuid;
      appState.isPolling = true;
      app.togglePolling(appState.isPolling);
    } else {
      notifyNotLoggedIn();
    }
  });

  //
  // Load the initial api endpoint value from storage
  //
  chrome.storage.sync.get('work_available_endpoint', data => {
    // Notify that we saved.
    if (data.work_available_endpoint !== undefined) {
      appState.work_available_endpoint = data.work_available_endpoint;
      appState.isPolling = true;
      app.togglePolling(appState.isPolling);
    } else {
      notifyNotLoggedIn();
    }
  });

  chrome.storage.sync.get(['worker_uuid', 'websocket_endpoint', 'websocket_auth'], data => {
    app.startWebsocket(data);
  });

  // Handle the icon being clicked
  //
  // this enables or disables checking for new work
  //
  chrome.browserAction.onClicked.addListener(() => {
    appState.isPolling = !appState.isPolling;
    app.togglePolling(appState.isPolling);
  });

  // Handle data coming from the main site
  chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
    if (request.data &&
        request.data.worker_uuid &&
        request.data.work_available_endpoint) {
      app.startApp(request, sendResponse);
    }
  });

  // Get user information
  chrome.identity.getProfileUserInfo(info => {
    appState.email = info.email;
    appState.id = info.id;
  });

  // Get idle checking - this drops the polling rate
  // for "inactive" users (i.e. when AFK)

  let shutOffTimer;
  chrome.idle.setDetectionInterval(DEFAULT_INTERVAL * 3 / 1000);
  chrome.idle.onStateChanged.addListener(state => {
    appState.tester_state = state;
    if (state === 'idle') {
      checkForWorkInterval = DEFAULT_INTERVAL * 10;
      shutOffTimer = setTimeout(() => {
        if (appState.tester_state === 'idle') {
          appState.isPolling = false;
          app.togglePolling(appState.isPolling);
        }
      }, DEFAULT_INTERVAL * 45);
    } else if (state === 'active') {
      clearTimeout(shutOffTimer);
      checkForWorkInterval = DEFAULT_INTERVAL;
    }
  });
}

function startApp(request, sendResponse) {
  appState.uuid = request.data.worker_uuid;
  appState.work_available_endpoint = request.data.work_available_endpoint;

  appState.isPolling = true;
  app.togglePolling(appState.isPolling);

  // comment this out in dev mode
  if (sendResponse) {
    sendResponse({ok: true});
  }

  chrome.storage.sync.set(
    {
      worker_uuid: request.data.worker_uuid,
      work_available_endpoint: request.data.work_available_endpoint,
      websocket_endpoint: request.data.websocket_endpoint,
      websocket_auth: request.data.websocket_auth,
    }
  );

  app.startWebsocket(request.data);
}

function startWebsocket(data) {
  if (data.websocket_endpoint === undefined ||
      data.worker_uuid === undefined ||
      data.websocket_auth === undefined ||
      appState.webSocketConnection !== undefined) {
    return;
  }

  appState.webSocketConnection = new SchruteConn(data.websocket_endpoint, data.worker_uuid, data.websocket_auth);
  appState.webSocketConnection.start();
}


// Set checking state

function notifyNotLoggedIn() {
  chrome.notifications.create('not_logged_in', notifications.notLoggedIn);
}

function togglePolling(enabled) {
  if (!enabled) {
    chrome.browserAction.setBadgeBackgroundColor({color: RED});
    chrome.browserAction.setBadgeText({text: 'OFF'});
  } else {
    if (appState.uuid) {
      app.checkForWork();
    } else {
      notifyNotLoggedIn();
    }
  }
}

// Open or focus the main work tab

function openOrFocusTab(url) {
  if (appState.workTab === null) {
    app.makeNewWorkTab(url);
  } else {
    app.refreshTabInfo();
  }
}

// Make sure the work tab is open and in focus
function refreshTabInfo() {
  chrome.tabs.get(appState.workTab.id, tab => {
    if (chrome.runtime.lastError) {
      appState.workTab = null;
    } else {
      appState.workTab = tab;

      // force selection
      if (!appState.workTab.selected) {
        chrome.tabs.update(appState.workTab.id, {selected: true});
      }
    }
  });
}

// Open a new work tab
function makeNewWorkTab(url) {
  // make a new tab
  chrome.tabs.create({url}, t => {
    appState.workTab = t;
  });
}

//
// Open a sync tab
//
function makeNewSyncTab() {
  // make a new tab
  chrome.tabs.create({url: appState.profileUrl});
}

function pingServer(url) {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);

    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4 && appState.isPolling) {
        resolve(JSON.parse(xhr.responseText));
      }
    };

    xhr.send();
  });
}

// Poll for new work
function checkForWork() {
  const userInfo = {
    uuid: appState.uuid,
    email: appState.email,
    id: appState.id,
    version: appState.version,
    tester_state: appState.tester_state};
  app.pingServer(
    `${appState.work_available_endpoint}${appState.uuid}/work_available?info=${JSON.stringify({userInfo})}`
  ).then(resp => {
    if (resp.work_available) {
      chrome.browserAction.setBadgeBackgroundColor({color: GREEN});
      chrome.browserAction.setBadgeText({text: 'YES'});

      app.openOrFocusTab(resp.url);
    } else {
      chrome.browserAction.setBadgeBackgroundColor({color: GREY});
      chrome.browserAction.setBadgeText({text: 'NO'});
    }

    if (appState.isPolling) {
      clearTimeout(timeout);
      timeout = setTimeout(app.checkForWork, checkForWorkInterval);
    }
  });
}

const app = {
  startApp,
  setupChromeEvents,
  appState,
  togglePolling,
  pingServer,
  checkForWork,
  makeNewWorkTab,
  refreshTabInfo,
  startWebsocket,
  openOrFocusTab,
};

// exposing this for dev mode
// Use in dev mode
// window._startRainforestTesterApp({
//   data: {
//     worker_uuid: 'your-worker-id',
//     work_available_endpoint: 'bouncer-url'}});
window._startRainforestTesterApp = app.startApp;

export default app;
