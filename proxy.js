/**
 * This is a lightly modified version of https://github.com/TooTallNate/proxy
 */

var net = require('net');
var url = require('url');
var http = require('http');
var assert = require('assert');
var util = require('util');

// hostname
var hostname = require('os').hostname();

// proxy server version
var version  = require('./package.json').version;

/**
 * Module exports.
 */

module.exports = setup;

var _logger;
function debug() {
  if (_logger) {
    _logger.info(util.format.apply(null, arguments));
  }
}

/**
 * Sets up an `http.Server` or `https.Server` instance with the necessary
 * "request" and "connect" event listeners in order to make the server act as an
 * HTTP proxy.
 *
 * @param {http.Server|https.Server} server
 * @param {Object} options
 * @api public
 */
function setup (server, options) {
  _logger = options.logger || null;
  if (!server) server = http.createServer();
  server.authenticate = options.authenticate;
  server.requestHandler = options.requestHandler;
  server.responseHandler = options.responseHandler;
  server.on('request', onrequest);
  server.on('connect', onconnect);
  return server;
}

/**
 * 13.5.1 End-to-end and Hop-by-hop Headers
 *
 * Hop-by-hop headers must be removed by the proxy before passing it on to the
 * next endpoint. Per-request basis hop-by-hop headers MUST be listed in a
 * Connection header, (section 14.10) to be introduced into HTTP/1.1 (or later).
 */

var hopByHopHeaders = [
  'Connection',
  'Keep-Alive',
  'Proxy-Authenticate',
  'Proxy-Authorization',
  'TE',
  'Trailers',
  'Transfer-Encoding',
  'Upgrade'
];

// create a case-insensitive RegExp to match "hop by hop" headers
var isHopByHop = new RegExp('^(' + hopByHopHeaders.join('|') + ')$', 'i');

/**
 * Iterator function for the request/response's "headers".
 * Invokes `fn` for "each" header entry in the request.
 *
 * @api private
 */

function eachHeader (obj, fn) {
  if (Array.isArray(obj.rawHeaders)) {
    // ideal scenario... >= node v0.11.x
    // every even entry is a "key", every odd entry is a "value"
    var key = null;
    obj.rawHeaders.forEach(function (v) {
      if (key === null) {
        key = v;
      } else {
        fn(key, v);
        key = null;
      }
    });
  } else {
    // otherwise we can *only* proxy the header names as lowercase'd
    var headers = obj.headers;
    if (!headers) return;
    Object.keys(headers).forEach(function (key) {
      var value = headers[key];
      if (Array.isArray(value)) {
        // set-cookie
        value.forEach(function (val) {
          fn(key, val);
        });
      } else {
        fn(key, value);
      }
    });
  }
}

/**
 * HTTP GET/POST/DELETE/PUT, etc. proxy requests.
 */

function onrequest (req, res) {
  var server = this;
  var socket = req.socket;

  // pause the socket during authentication so no data is lost
  socket.pause();

  authenticate(server, req, function (err, auth) {
    socket.resume();
    if (err) {
      // an error occured during login!
      res.writeHead(500);
      res.end((err.stack || err.message || err) + '\n');
      return;
    }
    if (!auth) return requestAuthorization(req, res);;
    var parsed = url.parse(req.url);

    // proxy the request HTTP method
    parsed.method = req.method;

    // setup outbound proxy request HTTP headers
    var headers = {};
    var hasXForwardedFor = false;
    var hasVia = false;
    var via = '1.1 ' + hostname + ' (proxy/' + version + ')';

    parsed.headers = headers;
    eachHeader(req, function (key, value) {
      var keyLower = key.toLowerCase();

      if (!hasXForwardedFor && 'x-forwarded-for' === keyLower) {
        // append to existing "X-Forwarded-For" header
        // http://en.wikipedia.org/wiki/X-Forwarded-For
        hasXForwardedFor = true;
        value += ', ' + socket.remoteAddress;
      }

      if (!hasVia && 'via' === keyLower) {
        // append to existing "Via" header
        hasVia = true;
        value += ', ' + via;
      }

      if (isHopByHop.test(key)) {
      } else {
        var v = headers[key];
        if (Array.isArray(v)) {
          v.push(value);
        } else if (null != v) {
          headers[key] = [ v, value ];
        } else {
          headers[key] = value;
        }
      }
    });

    // add "X-Forwarded-For" header if it's still not here by now
    // http://en.wikipedia.org/wiki/X-Forwarded-For
    if (!hasXForwardedFor) {
      headers['X-Forwarded-For'] = socket.remoteAddress;
    }

    // add "Via" header if still not set by now
    if (!hasVia) {
      headers.Via = via;
    }

    // custom `http.Agent` support, set `server.agent`
    var agent = server.agent;
    if (null != agent) {
      parsed.agent = agent;
      agent = null;
    }

    if (null == parsed.port) {
      // default the port number if not specified, for >= node v0.11.6...
      // https://github.com/joyent/node/issues/6199
      parsed.port = 80;
    }

    if ('http:' != parsed.protocol) {
      // only "http://" is supported, "https://" should use CONNECT method
      res.writeHead(400);
      res.end('Only "http:" protocol prefix is supported\n');
      return;
    }

    var gotResponse = false;
    if (server.requestHandler && server.requestHandler(parsed, res)) {
      return;
    }

    debug('%s %s HTTP/%s ', req.method, req.url, req.httpVersion);
    var proxyReq = http.request(parsed);

    proxyReq.on('response', function (proxyRes) {
      gotResponse = true;

      var headers = {};
      eachHeader(proxyRes, function (key, value) {
        if (isHopByHop.test(key)) {
        } else {
          var v = headers[key];
          if (Array.isArray(v)) {
            v.push(value);
          } else if (null != v) {
            headers[key] = [ v, value ];
          } else {
            headers[key] = value;
          }
        }
      });

      if (server.responseHandler) {
        server.responseHandler(parsed, proxyRes.statusCode, headers, proxyRes, res);
      } else {
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
      }
      res.on('finish', onfinish);
    });
    proxyReq.on('error', function (err) {
      cleanup();
      if (gotResponse) {
        // already sent a response to the original request...
        // just destroy the socket
        socket.destroy();
      } else if ('ENOTFOUND' == err.code) {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(500);
        res.end();
      }
    });

    // if the client closes the connection prematurely,
    // then close the upstream socket
    function onclose () {
      proxyReq.abort();
      cleanup();
    }
    socket.on('close', onclose);

    function onfinish () {
      cleanup();
    }

    function cleanup () {
      socket.removeListener('close', onclose);
      res.removeListener('finish', onfinish);
    }

    req.pipe(proxyReq);
  });
}

/**
 * HTTP CONNECT proxy requests.
 */

function onconnect (req, socket, head) {
  debug('%s %s HTTP/%s ', req.method, req.url, req.httpVersion);
  assert(!head || 0 == head.length, '"head" should be empty for proxy requests');

  // create the `res` instance for this request since Node.js
  // doesn't provide us with one :(
  // XXX: this is undocumented API, so it will break some day (ノಠ益ಠ)ノ彡┻━┻
  var res = new http.ServerResponse(req);
  res.shouldKeepAlive = false;
  res.chunkedEncoding = false;
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);

  // pause the socket during authentication so no data is lost
  socket.pause();

  // called for the ServerResponse's "finish" event
  // XXX: normally, node's "http" module has a "finish" event listener that would
  // take care of closing the socket once the HTTP response has completed, but
  // since we're making this ServerResponse instance manually, that event handler
  // never gets hooked up, so we must manually close the socket...
  function onfinish () {
    res.detachSocket(socket);
    socket.end();
  }
  res.once('finish', onfinish);

  authenticate(this, req, function (err, auth) {
    socket.resume();
    if (err) {
      // an error occured during login!
      res.writeHead(500);
      res.end((err.stack || err.message || err) + '\n');
      return;
    }
    if (!auth) return requestAuthorization(req, res);;

    var parts = req.url.split(':');
    var host = parts[0];
    var port = +parts[1];
    var opts = { host: host, port: port };
    var gotResponse = false;

    function onconnect () {
      gotResponse = true;
      res.removeListener('finish', onfinish);

      res.writeHead(200, 'Connection established');

      // HACK: force a flush of the HTTP header
      res._send('');

      // relinquish control of the `socket` from the ServerResponse instance
      res.detachSocket(socket);

      socket.pipe(destination);
      destination.pipe(socket);
    }

    function onclose () {
      cleanup();
      socket.destroy();
    }

    function onend () {
      cleanup();
    }

    function onerror (err) {
      cleanup();
      if (gotResponse) {
        socket.destroy();
      } else if ('ENOTFOUND' == err.code) {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(500);
        res.end();
      }
    }

    function cleanup () {
      destination.removeListener('connect', onconnect);
      destination.removeListener('close', onclose);
      destination.removeListener('error', onerror);
      destination.removeListener('end', onend);
    }

    var destination = net.connect(opts);
    destination.on('connect', onconnect);
    destination.on('close', onclose);
    destination.on('error', onerror);
    destination.on('end', onend);
  });
}

/**
 * Checks `Proxy-Authorization` request headers. Same logic applied to CONNECT
 * requests as well as regular HTTP requests.
 *
 * @param {http.Server} server
 * @param {http.ServerRequest} req
 * @param {Function} fn callback function
 * @api private
 */

function authenticate (server, req, fn) {
  var hasAuthenticate = 'function' == typeof server.authenticate;
  if (hasAuthenticate) {
    server.authenticate(req, fn);
  } else {
    // no `server.authenticate()` function, so just allow the request
    fn(null, true);
  }
}

/**
 * Sends a "407 Proxy Authentication Required" HTTP response to the `socket`.
 *
 * @api private
 */

function requestAuthorization (req, res) {
  // request Basic proxy authorization
  debug('requesting proxy authorization for "%s %s"', req.method, req.url);

  // TODO: make "realm" and "type" (Basic) be configurable...
  var realm = 'proxy';

  var headers = {
    'Proxy-Authenticate': 'Basic realm="' + realm + '"'
  };
  res.writeHead(407, headers);
  res.end();
}
