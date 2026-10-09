'use strict'

var Buffer = require('safe-buffer').Buffer
var test = require('tape').test
var msgpack = require('../')

var reservedByteError = '0xc1 is a reserved MessagePack byte'

// The browser bundles ship the same decoder and stream Decoder, so they are
// exercised too; they embed buffer@5, which cannot run on Node 0.10, so they
// are skipped there.
var bundlesUnsupported = /^v0\.10\./.test(process.version)
var implementations = [
  { name: 'lib', msgpack: msgpack, skip: false },
  { name: 'dist', msgpack: require('../dist/msgpack5'), skip: bundlesUnsupported },
  { name: 'dist min', msgpack: require('../dist/msgpack5.min'), skip: bundlesUnsupported }
]

// Runs `check` once every expected stream event happened (`isDone`), so the
// assertions do not depend on the order readable-stream emits 'close' and
// 'error' in. A decoder that stalls never gets there: the fallback timer then
// ends the test instead of leaving tape hanging.
function settle (t, isDone, check) {
  var finished = false
  var timer = setTimeout(function () {
    finish(true)
  }, 2000)

  function finish (timedOut) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    t.notOk(timedOut, 'decoder must not stall')
    check()
    t.end()
  }

  return function () {
    if (!finished && isDone()) {
      // let any stray extra event surface before asserting
      setTimeout(function () {
        finish(false)
      }, 20)
    }
  }
}

implementations.forEach(function (impl) {
  test('reserved byte is invalid rather than incomplete (' + impl.name + ')', { skip: impl.skip }, function (t) {
    t.plan(3)

    var pack = impl.msgpack()
    var error

    try {
      pack.decode(Buffer.from([0xc1]))
    } catch (err) {
      error = err
    }

    t.ok(error, 'must throw an error')
    t.notOk(error instanceof pack.IncompleteBufferError, 'must not report incomplete input')
    t.equal(error && error.message, reservedByteError, 'must identify the reserved byte')
  })

  test('nested reserved byte is invalid rather than incomplete (' + impl.name + ')', { skip: impl.skip }, function (t) {
    t.plan(3)

    var pack = impl.msgpack()
    var error

    try {
      // fixarray of two elements: 1, then the reserved byte
      pack.decode(Buffer.from([0x92, 0x01, 0xc1]))
    } catch (err) {
      error = err
    }

    t.ok(error, 'must throw an error')
    t.notOk(error instanceof pack.IncompleteBufferError, 'must not report incomplete input')
    t.equal(error && error.message, reservedByteError, 'must identify the reserved byte')
  })

  test('stream decoder rejects reserved byte without retaining input (' + impl.name + ')', { skip: impl.skip }, function (t) {
    var decoder = impl.msgpack().decoder()
    var decoded = 0
    var errors = []
    var closed = false
    var written = false

    var done = settle(t, function () {
      return errors.length > 0 && closed && written
    }, function () {
      t.equal(decoded, 0, 'must not emit decoded values')
      t.equal(errors.length, 1, 'must emit one error')
      t.equal(errors[0] && errors[0].message, reservedByteError, 'must emit the decoding error')
      t.equal(decoder._chunks.length, 0, 'must release buffered input')
      t.ok(decoder.destroyed, 'must stop accepting input')
    })

    decoder.on('data', function () {
      decoded++
    })

    decoder.on('error', function (err) {
      errors.push(err)
      done()
    })

    decoder.on('close', function () {
      closed = true
      done()
    })

    decoder.write(Buffer.concat([
      Buffer.from([0xc1]),
      Buffer.alloc(200 * 1024, 0x01)
    ]), function () {
      written = true
      done()
    })
  })

  test('stream decoder does not stall and buffer input written after a reserved byte (' + impl.name + ')', { skip: impl.skip }, function (t) {
    var decoder = impl.msgpack().decoder()
    var reservedErrors = 0
    var closed = false
    var firstWritten = false
    var secondWritten = false
    var secondWriteError = null

    var done = settle(t, function () {
      return reservedErrors > 0 && closed && firstWritten && secondWritten
    }, function () {
      t.equal(reservedErrors, 1, 'must emit the decoding error once')
      t.ok(secondWriteError, 'must reject input written after the decoding error')
      t.equal(decoder._writableState.length, 0, 'must not buffer input written after the decoding error')
      t.equal(decoder._chunks.length, 0, 'must release buffered input')
    })

    decoder.on('error', function (err) {
      if (err.message === reservedByteError) {
        reservedErrors++
      }
      done()
    })

    decoder.on('close', function () {
      closed = true
      done()
    })

    decoder.write(Buffer.from([0xc1]), function () {
      firstWritten = true
      done()
    })

    decoder.write(Buffer.alloc(200 * 1024, 0x01), function (err) {
      secondWritten = true
      secondWriteError = err
      done()
    })
  })
})
