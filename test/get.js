var http  = require('http'),
    Url   = require('url');
    proxy = require('../transmat-proxy');

var username = 'proxy';
var password = 'proxy';
var auth = 'Basic ' + new Buffer(username + ':' + password).toString('base64');

var proxy = new proxy.TransmatProxy({
  port: 8080,
  username: 'proxy',
  password: 'proxy'
})

function proxyOptions(url) {
  var u = Url.parse(url);
  var options = {
    host: "localhost",
    port:8080,
    path: url,
    headers: {
      Host: u.host + ((u.port && u.port!==80) ? ':' + u.port : ''),
      "Proxy-Authorization" : auth,
      "X-TransmatMaxAge" : 2000     // Two seconds
    }
  };
  return options;
}

function makeRequest(times) {
  http.get(proxyOptions("http://www.google.com"), function(res) {

    /*
    console.log("Status: " + res.statusCode);
    for (var h in res.headers) {
      console.log(h +': ' +res.headers[h]);
    }*/

    res.on('data', function(chunk) {
      //console.log(''+chunk);
    });

    res.on('end', function() {
      if (times) {
        setTimeout(function() {
          times--;
          makeRequest(times);
        },1000);
      }
    });

  }).on('error', function(e) {
    console.log("Got error: " + e.message);
  });
}

makeRequest(5);