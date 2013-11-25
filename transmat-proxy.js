/*
 * Very simple client controlled http GET proxy cache.
 *
 * See test/get.js for example use.
 */
var http            = require('http'),
    util            = require('util'),
    winston         = require('winston'),
    basicAuthParser = require('basic-auth-parser'),
    lru             = require('lru-cache'),
    proxy           = require('./proxy.js');

/*
 * Create new proxy
 * Options
 *  logger    - Logger to use
 *  port      - Port for proxy to listen on
 *  username  - username to login to proxy
 *  password  - password to login to proxy
 *  size - Maximum size of LRU cache in bytes (default 100M)
 *  masAge - Maximum age in seconds (default 7 days)
 */
function TransmatProxy(options) {
  var self = this;
  this._options = options;

  this._logger = options.logger;
  if (!this._logger) {
    this._logger = new (winston.Logger)({
      transports: [new (winston.transports.Console)()]
    });
  }

  this._lookup = lru({
    max: options.size || 50*1024*1024,
    length: function (n) { return n.length },
    maxAge: options.maxAge*1000 || (7*24*60*60*1000)
  });

  var server = proxy(http.createServer(),{
    logger: this._logger,
    authenticate: function() {return self.authenticate.apply(self,arguments)},
    requestHandler: function() {return self.requestHandler.apply(self,arguments)},
    responseHandler: function() {return self.responseHandler.apply(self,arguments)}
  });
  server.listen(options.port, function () {
    self._logger.info('Proxy server listening on port %d', options.port);
    self.reportStats();
  });
}

TransmatProxy.prototype.authenticate = function(req, done) {

  // parse the "Proxy-Authorization" header
  var auth = req.headers['proxy-authorization'];
  if (!auth) {
    return done(null, false);
  }
  var parsed = basicAuthParser(auth);
  return done(null,
    parsed.username === this._options.username &&
    parsed.password === this._options.password);
};

TransmatProxy.prototype.requestHandler = function(parsed, res) {

  // Do we have cached
  if (parsed.method !== "GET") {return false;}
  var doc = this._lookup.get(parsed.href);
  if (!doc) return false;

  // Check within age
  var maxAge = parsed.headers['x-transmatmaxage'];
  if (maxAge && (Date.now()-doc.timestamp > maxAge)) {
    return false;
  }

  // Write it
  res.writeHead(doc.status, doc.headers);
  for (var i=0; i< doc.data.length; i++) {
    res.write(doc.data[i]);
  }
  res.end();
  this._logger.info(util.format('GET %s from cache',parsed.href));
  return true;
};

TransmatProxy.prototype.responseHandler = function(parsed, status, headers, proxyRes, res) {
  var self = this;

  if (parsed.method === "GET") {

    var data = [];
    proxyRes.on('data', function (chunk) {
      data.push(chunk);
    });

    proxyRes.on('end', function() {
      res.writeHead(status, headers);
      var total = 0;
      for (var i=0; i< data.length; i++) {
        total += data[i].length;
        res.write(data[i]);
      }
      res.end();
      self._lookup.set(parsed.href, {status: status, headers: headers,
        length: total, data: data, timestamp: Date.now()})
    })
  } else {
    res.writeHead(status, headers);
    proxyRes.pipe(res);
  }
};

TransmatProxy.prototype.reportStats = function() {
  var self = this;
  this._logger.info(util.format('Proxy cache using %dM in %d objects',
    Number(this._lookup.length/(1024*1024)).toFixed(4),this._lookup.itemCount))

  setTimeout(function() {self.reportStats();}, 10*60*1000);
}

exports.TransmatProxy = TransmatProxy;
