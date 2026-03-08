const MessageTypes = {
  AUTH: "AUTH",
  AUTH_RESP: "AUTH_RESP",
  TEXT: "TEXT",
  FILE_START: "FILE_START",
  FILE_CHUNK: "FILE_CHUNK",
  FILE_END: "FILE_END",
  CLIPBOARD: "CLIPBOARD",
  PING: "PING",
  PONG: "PONG",
  PAIR_REQ: "PAIR_REQ",
  PAIR_RESP: "PAIR_RESP",
  ACK: "ACK",
  ERROR: "ERROR",
};

class Message {
  constructor(type, data = null, id = null) {
    this.type = type;
    this.id = id || Message.generateID();
    this.timestamp = Date.now();
    this.data = data;
  }

  static generateID() {
    return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  }

  encode() {
    return JSON.stringify(this);
  }

  static decode(data) {
    const parsed = JSON.parse(data);
    return new Message(parsed.type, parsed.data, parsed.id);
  }
}

module.exports = {
  MessageTypes,
  Message,
};
