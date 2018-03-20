import EventEmitter from 'events';
import RocketChat from './client';

export class ChatAdapterRocketChat {
  constructor() {
    this._name = 'ChatAdapterRocketChat';
    this._eventBus = new EventEmitter();
  }

  get name() {
    return this._name;
  }

  //
  // public API
  //
  init(config) {
    // sample config:
    // var config = {
    // backendUrl: string,
    // initData: {
    //    data: {
    //    username: string,
    //    password: string,
    //    channelId: string,
    //    }
    // }
    // }

    // console.debug('RC Adapter init', config);

    console.debug('Initializing communication with Rocket Chat...');

    this._backendUrl = config.backendUrl;
    this._initData = config.initData;
    let self = this;
    let clientConfig = {
      backendUrl: self._backendUrl,
      eventBus: self._eventBus,
      username: self._initData.data.username,
      password: self._initData.data.password,
      authToken: self._initData.data.authToken,
      userId: self._initData.data.userId,
      channelId: self._initData.data.channelId
    };

    return new Promise(function (resolve, reject) {
      self._client = new RocketChat(clientConfig);

      self._client.init()
      .then(response => {
        if (response.ok) {
          // both rest api and realtime api are succesfully authenticated, given user and password are correct
          resolve(response);
        } else {
          // some error ocurred
          console.error('Error initializing communication with Rocket Chat:', response.error);
          reject(`Error initializing communication with Rocket Chat: ${response.error}`);
        }
      })
      .catch(error => {
        console.error('Error initializing communication with Rocket Chat:', error);
        reject(error.message);
      });
    });
  }

  send(data) {
    this._client.postMessage(data);
  }

  on(event, callback) {
    this._eventBus.on(event, callback);
  }

  requestOlderMessages(data) {
    var self = this;

    // data = {
    //   deviceId: _deviceId,
    //   id: id of first already visible message,
    //   time: time of first already visible message
    // }
    //
    var lastTime = data === undefined ? Date.now() : data.time;

    return self._client.getOlderMessages(lastTime);
  }
}
