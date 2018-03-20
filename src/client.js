import DDP from 'ddp.js';
import sha256 from 'js-sha256';

export default class RocketChat {

  constructor(config) {
    // config has:
    // deviceId: xyz,
    // backendUrl: http://rocket.chat,
    // eventBus: EventEmiter instance
    // channelId,

    this._url = config.backendUrl;
    this._eventBus = config.eventBus;
    this._username = config.username;
    this._password = config.password;
    this._authToken = config.authToken;
    this._userId = config.userId;
    this._channelId = config.channelId;
    this._deferChannelSubscription = false;

    console.debug('RC Adapter Client init', config);
  }

  async init() {
    const self = this;

    const connection = await self.connectSocket();
    if(connection.ok) {
      const login = await self.login();
      if(login.ok) {
        const olderMessages = await self.getOlderMessages();
        if (olderMessages.status === 200) {
          self._lastMessages = olderMessages.data;
          const subscribe = await self.subscribeToChannel(self._channelId);
          if(subscribe.ok) {
            return ({
              ok: true,
              message: 'Rocket Chat connected and subscribed to messages',
              user: {
                username: self._username,
                avatar: self._userAvatar
              },
              message_count: self._messageCount,
              last_messages: self._lastMessages
            });
          } else {
            throw new Error({
              ok: false,
              message: subscribe.message
            });
          }
        } else {
          throw new Error({
            ok: false,
            message: response.message
          });
        }
      } else {
        throw new Error({
          ok: false,
          message: response.message
        });
      }
    }
  }

  connectSocket() {
    const self = this;
    let url = self._url + '/websocket';

    url = url.replace('https', 'wss');
    url = url.replace('http', 'ws');

    self._ddpClient = new DDP({
      endpoint: url,
      SocketConstructor: WebSocket
    });

    return new Promise(function (resolve, reject) {
      self._ddpClient.on('connected', () => {
        resolve({ok: true});
      });
    });
  }

  login() {
    const self = this;

    const methodId = self._ddpClient.method('login', [{
      'user': {'username': self._username},
      'password': {
        'digest': sha256(self._password),
        'algorithm': 'sha-256'
      }
    }]);

    return new Promise(function (resolve, reject) {
      self._ddpClient.on('result', message => {
        if (message.id === methodId) {
          if (!message.error) {
            console.log(message);
            self._authToken = message.result.token;
            self._userId = message.result.id;
            self._tokenExpires = message.result.tokenExpires; // TODO: handle expired tokens
            resolve({ok: true});
          } else {
            reject({ok: false, message: `Error logging in: ${message.error.message}`});
          }
        }
      });
    });
  }

  subscribeToChannel(channelId) {
    const self = this;

    return new Promise(function (resolve, reject) {
      const subId = self._ddpClient.sub('stream-room-messages', [channelId, false]);

      self._ddpClient.on('ready', message => {
        if (message.subs.includes(subId)) {

          self._ddpClient.on('changed', message => {
            self.handleNewMessage(message);
          });
          console.debug('subscribeToChannel ready', message);
          resolve({ok: true, message: 'stream-room-messages subscription ready'});
        } else {
          reject({ok: false, message: `Could not subscribe to RC room messages on ready: ${JSON.stringify(message)}`});
        }
      });

      self._ddpClient.on('nosub', message => {
        reject({ok: false, message: `Could not subscribe to RC room messages (nosub): ${JSON.stringify(message)}`});
      });
    });
  }

  handleNewMessage(message) {
    // sample message: {
    //  "msg":"changed",
    //    "collection":"stream-room-messages",
    //    "id":"id",
    //    "fields":{
    //  "eventName":"GENERAL",
    //      "args":[
    //    {
    //      "_id":"RbT9h6EzGXf8m3QLm",
    //      "rid":"GENERAL",
    //      "msg":"change 1212",
    //      "ts":{
    //        "$date":1507482740977
    //      },
    //      "u":{
    //        "_id":"kFBkJkorhN3gStxnr",
    //        "username":"admin",
    //        "name":"admin"
    //      },
    //      "mentions":[
    //      ],
    //      "channels":[
    //      ],
    //      "_updatedAt":{
    //        "$date":1507482740990
    //      }
    //    }
    //  ]
    // }
    //
    // }
    let from;
    let data;
    let args = (message.fields || {}).args;

    if (args !== null && args !== undefined) {
      if (args.length > 0) {
        from = args[0].u._id;
        if (from !== this._userId) {
          // new message from some chat user other than the browser user
          // TODO: handle more than one (first) entry in this array
          args = args[0];
          data = this.convertMessage(args);
          this._eventBus.emit('ucw:newRemoteMessage', data);
        }
      }
    }
  }

  postMessage(data) {
    this._ddpClient.method('sendMessage', [{
      '_id': data.id,
      'rid': this._channelId,
      'msg': data.text
    }]);
  }

  getOlderMessages(lastTime) {
    const self = this;
    let messages = [];

    const methodId = self._ddpClient.method('loadHistory', [
      self._channelId,
      lastTime === undefined ? null : {'$date': lastTime}, // since when to read
      10, // # of messages to retrieve
      {'$date': Date.now()} // last time user read messages
    ]);

    return new Promise(function (resolve, reject) {
      self._ddpClient.on('result', response => {
        if (response.id === methodId) {
          if (!response.error) {
            // TODO: figure out how to read a total message count from RC
            self._messageCount = response.result.messages.length;
            messages = response.result.messages;
            messages = messages.map(m => {
              return self.convertMessage(m);
            });
            messages.sort(function (a, b) {
              // Turn your strings into dates, and then subtract them
              // to get a value that is either negative, positive, or zero.
              return new Date(a.time) - new Date(b.time);
            });
            resolve({status: 200, data: messages});
          } else {
            if (response.error.error === 'error-invalid-room') {
              // this error fires on the first interaction with rocket chat: the room is just not yet created
              // we defer subscription to room messages until the first message from the user
              self._deferChannelSubscription = true;
              self._messageCount = 0;
              resolve({status: 200, data: []});
            } else {
              // some other error cause: bubble up the exception
              reject({status: 500, message: `Error loading messages: ${response.error.message}`});
            }
          }
        }
      });
    });
  }

  convertMessage(rocketMsg) {
    // Create new message for universal chat widget;
    // in 121 Services message format:
    // {
    //  time: msg.sent_at,
    //  from: {
    //    username: msg.session.bot.display_name,
    //    avatar: msg.session.bot.avatar_url
    //  },
    //  text: msg.text,
    //  direction: msg.direction,
    //  buttons: msg.buttons,
    //  elements: msg.elements,
    //  attachment: msg.attachment
    // }

    if (this._userAvatar === undefined && rocketMsg.avatar !== undefined) {
      // update user avatar
      // TODO: find a better method to read user avatar from RC
      this._userAvatar = rocketMsg.avatar;
    }

    return {
      time: rocketMsg.ts.$date,
      from: {
        username: rocketMsg.u.name || rocketMsg.u.username,
        avatar: rocketMsg.avatar || ''
      },
      text: rocketMsg.msg,
      direction: rocketMsg.u._id === this._userId ? 2 : 1,
      buttons: null,
      elements: null,
      attachment: null
    };
  }
}
