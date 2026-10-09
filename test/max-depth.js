'use strict'

var Buffer = require('safe-buffer').Buffer
var test = require('tape').test
var msgpack = require('../')

var depthError = /Maximum decode depth exceeded/

// The browser bundles ship the same decoder and stream Decoder, so they are
// exercised too; they embed buffer@5, which cannot run on Node 0.10, so they
// are skipped there.
var bundlesUnsupported = /^v0\.10\./.test(process.version)
var implementations = [
  { name: 'lib', msgpack: msgpack, skip: false },
  { name: 'dist', msgpack: require('../dist/msgpack5'), skip: bundlesUnsupported },
  { name: 'dist min', msgpack: require('../dist/msgpack5.min'), skip: bundlesUnsupported }
]

// `depth` levels of a container header, each holding the next level, with a
// nil at the bottom
function nested (depth, header) {
  var prefix = Buffer.alloc(depth * header.length)

  for (var i = 0; i < depth; i++) {
    for (var j = 0; j < header.length; j++) {
      prefix[i * header.length + j] = header[j]
    }
  }

  return Buffer.concat([prefix, Buffer.from([0xc0])])
}

function nestedArray (depth) {
  // fixarray of one element
  return nested(depth, [0x91])
}

function nestedMap (depth) {
  // fixmap of one entry, keyed by the fixstr 'x'
  return nested(depth, [0x81, 0xa1, 0x78])
}

// every container header the decoder recurses into
var containers = [
  { name: 'fixarray', header: [0x91] },
  { name: 'array 16', header: [0xdc, 0x00, 0x01] },
  { name: 'array 32', header: [0xdd, 0x00, 0x00, 0x00, 0x01] },
  { name: 'fixmap', header: [0x81, 0xa1, 0x78] },
  { name: 'map 16', header: [0xde, 0x00, 0x01, 0xa1, 0x78] }
]

// deep enough to exhaust the native stack of an unbounded recursive decoder
var hostileDepth = 50000

// Collects what the stream decoder emits for `payload` and runs `check` once
// it errored or ended. A decoder that stalls never gets there: the fallback
// timer then ends the test instead of leaving tape hanging.
function streamDecode (t, pack, payload, check) {
  var decoder = pack.decoder()
  var decoded = []
  var errors = []
  var finished = false
  var timer = setTimeout(function () {
    finish(true)
  }, 2000)

  function finish (timedOut) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    t.notOk(timedOut, 'decoder must not stall')
    check(errors, decoded)
    t.end()
  }

  function settle () {
    // let any stray extra event surface before asserting
    setTimeout(function () {
      finish(false)
    }, 20)
  }

  decoder.on('data', function (obj) {
    decoded.push(obj)
  })

  decoder.on('error', function (err) {
    errors.push(err)
    settle()
  })

  decoder.on('end', settle)

  decoder.end(payload)
}

implementations.forEach(function (impl) {
  var suffix = ' (' + impl.name + ')'
  var opts = { skip: impl.skip }

  test('limits array and map nesting depth by default' + suffix, opts, function (t) {
    var pack = impl.msgpack()
    var array = pack.decode(nestedArray(100))
    var map = pack.decode(nestedMap(100))

    for (var i = 0; i < 100; i++) {
      array = array[0]
      map = map.x
    }

    t.equal(array, null, 'decodes arrays at the limit')
    t.equal(map, null, 'decodes maps at the limit')
    t.throws(function () {
      pack.decode(nestedArray(101))
    }, depthError, 'rejects arrays over the limit')
    t.throws(function () {
      pack.decode(nestedMap(101))
    }, depthError, 'rejects maps over the limit')
    t.end()
  })

  test('supports a custom maximum nesting depth' + suffix, opts, function (t) {
    var pack = impl.msgpack({ maxDepth: 2 })

    t.doesNotThrow(function () {
      pack.decode(nestedArray(2))
    }, 'decodes input at the configured limit')
    t.throws(function () {
      pack.decode(nestedArray(3))
    }, depthError, 'rejects input over the configured limit')
    t.end()
  })

  test('defaults maxDepth when other options are provided' + suffix, opts, function (t) {
    var options = [
      { forceFloat64: true },
      { compatibilityMode: true },
      { protoAction: 'remove' },
      { maxDepth: undefined }
    ]

    options.forEach(function (o) {
      var pack = impl.msgpack(o)

      t.doesNotThrow(function () {
        pack.decode(nestedArray(100))
      }, 'decodes input at the default limit')
      t.throws(function () {
        pack.decode(nestedArray(101))
      }, depthError, 'rejects input over the default limit')
    })
    t.end()
  })

  test('allows scalars but no containers when maxDepth is zero' + suffix, opts, function (t) {
    var pack = impl.msgpack({ maxDepth: 0 })

    t.equal(pack.decode(Buffer.from([0xc0])), null, 'decodes a scalar')
    t.throws(function () {
      pack.decode(Buffer.from([0x90]))
    }, depthError, 'rejects an empty array')
    t.throws(function () {
      pack.decode(Buffer.from([0x80]))
    }, depthError, 'rejects an empty map')
    t.end()
  })

  test('validates maxDepth' + suffix, opts, function (t) {
    var invalid = [-1, 1.5, Infinity, NaN, '100', null]

    invalid.forEach(function (maxDepth) {
      t.throws(function () {
        impl.msgpack({ maxDepth: maxDepth })
      }, /maxDepth must be a non-negative integer/)
    })
    t.end()
  })

  containers.forEach(function (container) {
    test('rejects hostile ' + container.name + ' nesting without exhausting the stack' + suffix, opts, function (t) {
      var pack = impl.msgpack()
      var error

      try {
        pack.decode(nested(hostileDepth, container.header))
      } catch (err) {
        error = err
      }

      t.ok(error, 'must throw an error')
      t.notOk(error instanceof RangeError, 'must not exhaust the native stack')
      t.equal(error && error.message, 'Maximum decode depth exceeded', 'must report the depth limit')
      t.end()
    })
  })

  test('reports a controlled error from the decoder stream' + suffix, opts, function (t) {
    streamDecode(t, impl.msgpack(), nestedArray(101), function (errors, decoded) {
      t.equal(decoded.length, 0, 'must not emit decoded values')
      t.equal(errors.length, 1, 'must emit one error')
      t.equal(errors[0] && errors[0].message, 'Maximum decode depth exceeded')
      t.notOk(errors[0] instanceof RangeError, 'does not exhaust the native stack')
    })
  })

  test('reports a controlled error from the decoder stream on hostile nesting' + suffix, opts, function (t) {
    streamDecode(t, impl.msgpack(), nestedArray(hostileDepth), function (errors, decoded) {
      t.equal(decoded.length, 0, 'must not emit decoded values')
      t.equal(errors.length, 1, 'must emit one error')
      t.equal(errors[0] && errors[0].message, 'Maximum decode depth exceeded')
      t.notOk(errors[0] instanceof RangeError, 'does not exhaust the native stack')
    })
  })
})
