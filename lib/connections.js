var events = require('events');
var Q = require('q');
var util = require('util');
var sockjs = require('sockjs');

var auth = require('./auth.js');
var conf = require('./config.js');
var db = require('./db.js');
var error = require('./error.js');
var Filter = require('./filter.js').Filter;
var keyedset = require('./keyedset.js');
var msgid = require('./msgid.js');

// Thin wrapper over a SockJS's connection to parse things out as JSON
// and abort on error.
function Connection(conn) {
  events.EventEmitter.call(this);

  this.lastReceive = new Date().getTime();

  this.conn_ = conn;

  this.closeCb_ = this.onClose_.bind(this);
  this.conn_.on('close', this.closeCb_);

  this.conn_.on('data', function(data) {
    this.lastReceive = new Date().getTime();
    try {
      var message = JSON.parse(data);
    } catch (err) {
      this.conn_.close(4000, 'Bad message format');
      return;
    }
    this.emit('message', message);
  }.bind(this));
};
util.inherits(Connection, events.EventEmitter);
Connection.prototype.sockjs = function() {
  // Bah. Too lazy to expose all the properties.
  return this.conn_;
};
Connection.prototype.onClose_ = function() {
  this.conn_.removeListener('close', this.closeCb_);
  this.emit('close');
};
Connection.prototype.close = function(code, reason) {
  this.conn_.close(code, reason);
  // Work around SockJS delaying close events. It's kinda
  // silly. Unfortunately, until that 5 seconds delay, sockjs-node is
  // going to internally retain some of the socket in-memory. But at
  // least avoid keeping our own bits around.
  //
  // See https://github.com/sockjs/sockjs-node/issues/133
  process.nextTick(this.closeCb_);
};
Connection.prototype.send = function(message) {
  this.conn_.write(JSON.stringify(message));
};

// TODO(davidben): Version the socket API.

function ConnectionManager(server, subscriber) {
  this.sockServer_ = sockjs.createServer({
    sockjs_url: '/sockjs.min.js'
  });
  this.activeUsers_ = { };
  this.subscriber_ = subscriber;

  this.unauthenticatedSockets_ = new keyedset.KeyedSet();

  this.sockServer_.installHandlers(server, {
    prefix: '/v1/socket',
    log: function(severity, line) {
      // Okay, why does SockJS spew everything?
      if (severity != 'error')
        return;
      console.error(line);
    }
  });

  this.sockServer_.on('connection', this.onConnection_.bind(this));
  this.subscriber_.on('message', this.onMessage_.bind(this));

  this.subscriber_.on('subscribe', function(user, clientId, subs) {
    this.broadcast(user, clientId, {
      type: 'subscribed',
      subs: subs
    });
  }.bind(this));
  this.subscriber_.on('unsubscribe', function(user, clientId, sub) {
    this.broadcast(user, clientId, {
      type: 'unsubscribed',
      subs: [sub]
    });
  }.bind(this));

  setInterval(this.checkExpiredSockets_.bind(this),
              conf.get('socketIdleTimeout') / 2);
  setInterval(this.checkUnauthenticatedSockets_.bind(this),
              conf.get('unauthenticatedSocketTimeout') / 2);

  // Debug info to monitor socket state. Every 10 minutes, print out
  // how many sockets davidben has open.
  setInterval(this.dumpDavidbenInfo_.bind(this), 5 * 60 * 1000);
}

ConnectionManager.prototype.checkUnauthenticatedSockets_ = function() {
  var now = new Date().getTime();
  this.unauthenticatedSockets_.forEach(function(socket) {
    if (now - socket.lastReceive >
        conf.get('unauthenticatedSocketTimeout')) {
      console.log('Closing idle unauthenticated socket');
      socket.close(4005, 'Idle socket');
    }
  });
}

ConnectionManager.prototype.checkExpiredSockets_ = function() {
  var now = new Date().getTime();
  Object.keys(this.activeUsers_).forEach(function(id) {
    this.activeUsers_[id].sockets_.forEach(function(socket) {
      if (now - socket.lastReceive > conf.get('socketIdleTimeout')) {
        console.log('Closing idle socket');
        socket.close(4005, 'Idle socket');
      }
    })
  }, this);
};

ConnectionManager.prototype.dumpDavidbenInfo_ = function() {
  // To help debug some socket thing.
  var davidben = 1;
  var now = new Date().getTime();
  console.log('==== %d unauthenticated sockets',
              this.unauthenticatedSockets_.length);
  this.unauthenticatedSockets_.forEach(function(socket) {
    console.log('      %d %s %s:%d rs=%d rd=%d wr=%d (%s) %s',
                (now - socket.lastReceive) / 1000.0,
                socket.conn_.protocol,
                socket.conn_.remoteAddress,
                socket.conn_.remotePort,
                socket.conn_.readyState,
                socket.conn_.readable ? 1 : 0,
                socket.conn_.writable ? 1 : 0,
                socket.conn_.headers['x-real-ip'],
                socket.conn_.headers['user-agent']);
  });
  if (!this.activeUsers_[davidben]) {
    console.log('==== davidben is not active');
  } else {
    console.log('==== davidben has (%d = %d) active sockets and %d active tails',
                this.activeUsers_[davidben].ref_,
                this.activeUsers_[davidben].sockets_.length,
                this.activeUsers_[davidben].activeTails_.length);
    this.activeUsers_[davidben].sockets_.forEach(function(socket) {
      console.log('      %d %s %s:%d rs=%d rd=%d wr=%d (%s) %s',
                  (now - socket.lastReceive) / 1000.0,
                  socket.conn_.protocol,
                  socket.conn_.remoteAddress,
                  socket.conn_.remotePort,
                  socket.conn_.readyState,
                  socket.conn_.readable ? 1 : 0,
                  socket.conn_.writable ? 1 : 0,
                  socket.conn_.headers['x-real-ip'],
                  socket.conn_.headers['user-agent']);
    });
  }
};

ConnectionManager.prototype.broadcast = function(user, clientId, msg) {
  if (!this.activeUsers_[user.id])
    return;
  this.activeUsers_[user.id].broadcast(clientId, msg);
};

ConnectionManager.prototype.onConnection_ = function(conn) {
  conn = new Connection(conn);

  // Track the socket in unauthenticated sockets.
  var sockKey = this.unauthenticatedSockets_.add(conn);
  var removed = false;
  var removeSocket = function() {
    if (removed)
      return;
    conn.removeListener('close', removeSocket);
    this.unauthenticatedSockets_.removeKey(sockKey);
    removed = true;
  }.bind(this);
  conn.on('close', removeSocket);

  conn.once('message', function(msg) {
    if (msg.type !== 'auth') {
      conn.close(4001, 'Auth message expected');
      return;
    }
    var token = msg.token;
    if (typeof token !== 'string') {
      conn.close(4002, 'Bad auth token');
      return;
    }
    conn.clientId = msg.clientId;
    auth.checkAuthToken(token).then(function(user) {
      if (!this.activeUsers_[user.id])
        this.activeUsers_[user.id] = new ActiveUser(this, user);

      // Move the socket to the relevant ActiveUser.
      removeSocket();
      this.activeUsers_[user.id].addSocket(conn);
      conn.send({type: 'ready'});
    }.bind(this), function(err) {
      if (err instanceof error.UserError) {
        conn.close(4003, err.msg);
      } else {
        conn.close(4004, 'Internal error');
      }
    }.bind(this)).done();
  }.bind(this));
};

ConnectionManager.prototype.onMessage_ = function(msg, userIds) {
  // Only compute the sealed id once.
  var sealedId = msgid.seal(msg.id);
  // Deliver the message to anyone who might care.
  userIds.forEach(function(userId) {
    if (!this.activeUsers_[userId])
      return;
    this.activeUsers_[userId].onMessage(msg, sealedId);
  }.bind(this));
};

function ActiveUser(parent, user) {
  this.parent_ = parent;
  this.user_ = user;

  this.ref_ = 0;
  this.activeTails_ = new keyedset.KeyedSet();
  this.sockets_ = new keyedset.KeyedSet();
}

ActiveUser.prototype.addSocket = function(socket) {
  var sockKey = this.sockets_.add(socket);
  this.ref_++;
  if (this.user_.id === 1) {
    console.log('==== davidben opened a socket (num = %d = %d; %s:%d)',
                this.ref_, this.sockets_.length,
                socket.conn_.remoteAddress, socket.conn_.remotePort);
    this.parent_.dumpDavidbenInfo_();
  }

  // This stuff should possibly be enclosed in YET ANOTHER class
  // rather than a closure...
  var tails = {};

  socket.on('close', function() {
    // Shut off all the tails, so we stop sending messages through
    // them.
    for (var key in tails) {
      tails[key].close();
      delete tails[key];
    }

    // Bah.
    if (--this.ref_ <= 0)
      delete this.parent_.activeUsers_[this.user_.id];
    this.sockets_.removeKey(sockKey);
    if (this.user_.id === 1) {
      console.log('==== davidben closed a socket (num = %d = %d; %s:%d)',
                  this.ref_, this.sockets_.length,
                  socket.conn_.remoteAddress, socket.conn_.remotePort);
      this.parent_.dumpDavidbenInfo_();
    }
  }.bind(this));

  socket.on('message', function(msg) {
    if (msg.type === 'ping') {
      socket.send({type: 'pong'});
    } else if (msg.type === 'new-tail') {
      var id = msg.id, start = msg.start, inclusive = msg.inclusive;
      if (typeof id !== 'number' ||
          (start != null && typeof start !== 'string')) {
        socket.close(4005, 'Bad message');
        return;
      }

      if (start != null) {
        start = msgid.unseal(start);
        if (inclusive)
          start--;
      } else {
        start = 0;
      }

      var filter = new Filter(msg);

      if (tails[id]) {
        // Uh, you shouldn't reuse ids, but okay...
        tails[id].close();
      }
      tails[id] = new Tail(this, socket, id, start, filter);
    } else if (msg.type === 'extend-tail') {
      var id = msg.id, count = msg.count;
      if (typeof id !== 'number' || typeof count !== 'number') {
        socket.close(4005, 'Bad message');
        return;
      }

      if (tails[id])
        tails[id].extend(count);
    } else if (msg.type === 'close-tail') {
      var id = msg.id;
      if (typeof id !== 'number') {
        socket.close(4005, 'Bad message');
        return;
      }

      if (tails[id]) {
        tails[id].close();
        delete tails[id];
      }
    }
  }.bind(this));
};

ActiveUser.prototype.broadcast = function(clientId, msg) {
  this.sockets_.forEach(function(socket) {
    // Don't broadcast to self.
    if (clientId != null && socket.clientId == clientId)
      return;
    socket.send(msg);
  });
};

ActiveUser.prototype.onMessage = function(msg, sealedId) {
  // Forward to each tail that is listening.
  this.activeTails_.forEach(function(tail) {
    tail.onMessage(msg, sealedId);
  });
};

function Tail(user, socket, id, lastSent, filter) {
  // Possible states:
  //
  // - FULL-TAIL : |messagesWanted_| = 0, so there's no need to
  //   request new messages. |active_| and |messageBuffer_| should
  //   both be null. When |messagesWanted_| becomes non-zero, we fire
  //   a DB query and go into DB-WAIT.
  //
  // - DB-WAIT : |active_| is not null and |messageBuffer_| is not
  //   null. Whenever we are doing a DB query, we are also listening
  //   for live messages to do the handoff properly. They end up in
  //   |messageBuffer_|. When the DB query returns, we either go to
  //   FULL-TAIL, another instance of DB-WAIT (because the user raced
  //   with us in calling extend or we hit |db.getMessage|'s result
  //   size limit), or LIVE-STREAM
  //
  // - LIVE-STREAM : |active_| is not null and |messageBuffer_| is
  //   null. This means that our most recent DB query was done but
  //   there was still room in |messagesWanted_|. In that case, we
  //   switch to just forwarding messages straight from the
  //   subscriber. We stay in this state until |messagesWanted_| is 0
  //   and go into FULL-TAIL.

  this.user_ = user;
  this.socket_ = socket;
  this.id_ = id;
  this.filter_ = filter;

  this.active_ = null;
  this.messageBuffer_ = null;

  this.lastSent_ = lastSent;
  this.messagesSent_ = 0;
  this.messagesWanted_ = 0;
}

Tail.prototype.close = function() {
  this.socket_ = null;
  this.deactivate_();
};

Tail.prototype.extend = function(count) {
  this.messagesWanted_ = Math.max(count - this.messagesSent_,
                                  this.messagesWanted_);
  this.fireQuery_();
};

Tail.prototype.activate_ = function() {
  if (this.active_ == null) {
    this.active_ = this.user_.activeTails_.add(this);
  }
};

Tail.prototype.deactivate_ = function() {
  if (this.active_ != null) {
    this.user_.activeTails_.removeKey(this.active_);
    this.active_ = null;
  }
};

Tail.prototype.fireQuery_ = function() {
  if (this.socket_ == null)
    return;

  // We're either in LIVE-STREAM or already in DB-WAIT. Do nothing.
  if (this.active_ != null)
    return;

  // We're in FULL-TAIL and should stay that way.
  if (this.messagesWanted_ == 0)
    return;

  // Activate live stream in buffer-messages mode.
  this.activate_();
  this.messageBuffer_ = [];
  // Make the DB query.
  this.user_.parent_.subscriber_.getMessages(
    this.user_.user_, this.lastSent_, this.filter_, {
      limit: this.messagesWanted_,
      reverse: false
    }
  ).then(function(result) {
    if (this.socket_ == null)
      return;

    // First, send the result along.
    if (result.messages.length) {
      var lastId = result.messages[result.messages.length - 1].id;
      result.messages.forEach(function(msg) {
        msg.id = msgid.seal(msg.id);
      });
      this.emitMessages_(result.messages, result.isDone);
      this.lastSent_ = lastId;
    } else {
      this.emitMessages_([], result.isDone);
    }

    // This was (at query time) the end of the database. Now we
    // transition to LIVE-STREAM mode.
    if (result.isDone && this.messagesWanted_) {
      var messageBuffer = this.messageBuffer_;
      this.messageBuffer_ = null;

      // But first, to make the hand-off atomic, we send what messages
      // in the buffer weren't seen yet.
      var start;
      for (start = 0; start < messageBuffer.length; start++) {
        if (messageBuffer[start][0].id > this.lastSent_)
          break;
      }
      messageBuffer = messageBuffer.slice(start);
      if (messageBuffer.length > 0) {
        var sealedMsgs = messageBuffer.map(function(entry) {
          var msg = entry[0], sealedId = entry[1];
          var sealedMsg = { };
          for (var key in msg) {
            sealedMsg[key] = msg[key];
          }
          sealedMsg.id = sealedId;
          return sealedMsg;
        });
        this.emitMessages_(sealedMsgs, true);
        this.lastSent_ = messageBuffer[messageBuffer.length - 1][0].id;
      }
    } else {
      // Otherwise... we deactivate everything and check if we need to
      // fire a query again.
      this.messageBuffer_ = null;
      this.deactivate_();
      this.fireQuery_();
    }
  }.bind(this), function(err) {
    // Uhhh... we can't find the database?? Shut off the socket and
    // make the client deal, I guess. Although that's going to fire up
    // an reconnect loop and stuff.
    console.error('Failed to get messages', err);
    if (this.socket_ != null)
      this.socket_.close(4006, 'Internal error');
  }.bind(this)).done();
};

Tail.prototype.onMessage = function(msg, sealedId) {
  if (!this.socket_)
    return;

  if (!this.filter_.matchesMessage(msg))
    return;

  if (this.lastSent_ >= msg.id)
    return;

  if (this.messageBuffer_) {
    this.messageBuffer_.push([msg, sealedId]);
    return;
  }

  // We're active and not in message buffering mode. Forward them
  // through the socket. isDone is true since the tail is caught up.
  var sealedMsg = { };
  for (var key in msg) {
    sealedMsg[key] = msg[key];
  }
  sealedMsg.id = sealedId;

  this.emitMessages_([sealedMsg], true);
  this.lastSent_ = msg.id;
  // Transition out of LIVE-STREAM mode if needbe.
  if (this.messagesWanted_ <= 0) {
    this.deactivate_();
  }
};

Tail.prototype.emitMessages_ = function(msgs, isDone) {
  this.socket_.send({
    type: 'messages',
    id: this.id_,
    messages: msgs,
    isDone: isDone
  });
  this.messagesSent_ += msgs.length;
  this.messagesWanted_ -= msgs.length;
};

exports.listen = function(server, messageQueue) {
  return new ConnectionManager(server, messageQueue);
};