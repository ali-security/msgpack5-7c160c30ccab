'use strict'

var Buffer = require('safe-buffer').Buffer
var test = require('tape').test
var msgpack = require('../')
var BufferList = require('bl')

test('must send an object through', function (t) {
  t.plan(1)

  var pack = msgpack()
  var encoder = pack.encoder()
  var decoder = pack.decoder()
  var data = { hello: 'world' }

  encoder.pipe(decoder)

  decoder.on('data', function (chunk) {
    t.deepEqual(chunk, data)
  })

  encoder.end(data)
})

test('must send three objects through', function (t) {
  var pack = msgpack()
  var encoder = pack.encoder()
  var decoder = pack.decoder()
  var data = [
    { hello: 1 },
    { hello: 2 },
    { hello: 3 }
  ]

  t.plan(data.length)

  decoder.on('data', function (chunk) {
    t.deepEqual(chunk, data.shift())
  })

  data.forEach(encoder.write.bind(encoder))

  encoder.pipe(decoder)

  encoder.end()
})

test('end-to-end', function (t) {
  var pack = msgpack()
  var encoder = pack.encoder()
  var decoder = pack.decoder()
  var data = [
    { hello: 1 },
    { hello: 2 },
    { hello: 3 }
  ]

  t.plan(data.length)

  decoder.on('data', function (chunk) {
    t.deepEqual(chunk, data.shift())
  })

  data.forEach(encoder.write.bind(encoder))

  encoder.end()

  encoder.pipe(decoder)
})

test('encoding error wrapped', function (t) {
  t.plan(1)

  var pack = msgpack()
  var encoder = pack.encoder()
  var data = new MyType()

  function MyType () {
  }

  function mytypeEncode () {
    throw new Error('muahha')
  }

  function mytypeDecode () {
  }

  pack.register(0x42, MyType, mytypeEncode, mytypeDecode)

  encoder.on('error', function (err) {
    t.equal(err.message, 'muahha')
  })

  encoder.end(data)
})

test('decoding error wrapped', function (t) {
  t.plan(1)

  var pack = msgpack()
  var encoder = pack.encoder()
  var decoder = pack.decoder()
  var data = new MyType()

  function MyType () {
  }

  function mytypeEncode () {
    return Buffer.allocUnsafe(0)
  }

  function mytypeDecode () {
    throw new Error('muahha')
  }

  pack.register(0x42, MyType, mytypeEncode, mytypeDecode)

  decoder.on('error', function (err) {
    t.equal(err.message, 'muahha')
  })

  encoder.end(data)

  encoder.pipe(decoder)
})

test('decoding error wrapped', function (t) {
  t.plan(1)

  var pack = msgpack()
  var encoder = pack.encoder({ header: false })
  var decoder = pack.decoder({ header: false })
  var data = new MyType()

  function MyType () {
  }

  function mytypeEncode () {
    return Buffer.allocUnsafe(0)
  }

  function mytypeDecode () {
    throw new Error('muahha')
  }

  pack.register(0x42, MyType, mytypeEncode, mytypeDecode)

  decoder.on('error', function (err) {
    t.equal(err.message, 'muahha')
  })

  encoder.end(data)

  encoder.pipe(decoder)
})

test('concatenated buffers work', function (t) {
  var pack = msgpack()
  var encoder = pack.encoder()
  var decoder = pack.decoder()
  var data = [
    { hello: 1 },
    { hello: 2 },
    { hello: 3 }
  ]

  t.plan(data.length)

  var bl = new BufferList()
  encoder.on('data', bl.append.bind(bl))

  data.forEach(encoder.write.bind(encoder))

  decoder.on('data', function (d) {
    t.deepEqual(d, data.shift())
  })

  encoder.once('finish', function () {
    var buf = bl.slice()
    decoder.write(buf)
  })

  encoder.end()
})

// the encoded bytes of `values`, one after the other
function encodeAll (pack, values) {
  var bytes = []

  values.forEach(function (value) {
    var encoded = pack.encode(value)
    for (var i = 0; i < encoded.length; i++) {
      bytes.push(encoded[i])
    }
  })

  return bytes
}

// `depth` levels of a container header, each holding the next level, with a
// nil at the bottom
function nested (depth, header) {
  var bytes = []

  for (var i = 0; i < depth; i++) {
    bytes = bytes.concat(header)
  }

  return bytes.concat([0xc0])
}

// Writes `bytes` to a new decoder `size` bytes at a time, and calls
// `cb(timedOut, errors, decoded)` once the decoder errored or ended. Writing
// stops as soon as the decoder is destroyed. A decoder that stalls never gets
// there: the fallback timer then calls `cb` instead of leaving tape hanging.
function decodeInChunks (pack, bytes, size, cb) {
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
    cb(timedOut, errors, decoded)
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

  for (var i = 0; i < bytes.length && !decoder.destroyed; i += size) {
    decoder.write(Buffer.from(bytes.slice(i, i + size)))
  }

  if (!decoder.destroyed) {
    decoder.end()
  }
}

// calls `fn(item, next)` for each of `items` one after the other, then `done`
function series (items, fn, done) {
  var i = 0

  function next () {
    if (i === items.length) return done()
    fn(items[i++], next)
  }

  next()
}

// the stream Decoder must not recurse once per buffered value: a single chunk
// carrying many small values used to overflow the call stack.
// The browser bundles are exercised too, as they ship the same Decoder; they
// embed buffer@5, which cannot run on Node 0.10, so they are skipped there.
var bundlesUnsupported = /^v0\.10\./.test(process.version)
var implementations = [
  { name: 'lib', msgpack: msgpack, skip: false },
  { name: 'dist', msgpack: require('../dist/msgpack5'), skip: bundlesUnsupported },
  { name: 'dist min', msgpack: require('../dist/msgpack5.min'), skip: bundlesUnsupported }
]

implementations.forEach(function (impl) {
  var suffix = ' (' + impl.name + ')'
  var opts = { skip: impl.skip }

  test('many concatenated values do not overflow the stack (' + impl.name + ')', { skip: impl.skip }, function (t) {
    t.plan(2)

    var total = 50000
    var decoder = impl.msgpack().decoder()
    var decoded = 0

    decoder.on('data', function () {
      decoded++
    })

    decoder.write(Buffer.alloc(total, 0x01), function (err) {
      t.error(err, 'must decode without an error')
      t.equal(decoded, total, 'must decode every value')
    })
  })

  // a container split across many chunks used to be decoded again from its
  // first element on every chunk, which is quadratic in the number of chunks
  test('incomplete containers resume without decoding elements again' + suffix, opts, function (t) {
    t.plan(3)

    var pack = impl.msgpack()
    var decoder = pack.decoder()
    var values = []
    var decodeCalls = 0
    var maxBuffered = 0
    var i

    function MyType (value) {
      this.value = value
    }

    pack.register(0x42, MyType, function (obj) {
      return Buffer.from([obj.value])
    }, function (buf) {
      decodeCalls++
      return buf.readUInt8(0)
    })

    for (i = 0; i < 100; i++) {
      values.push(new MyType(i))
    }

    decoder.on('data', function (result) {
      t.deepEqual(result, { values: values.map(function (value) { return value.value }) })
      t.equal(decodeCalls, values.length, 'each completed element is decoded once')
    })

    var encoded = pack.encode({ values: values })
    for (i = 0; i < encoded.length; i++) {
      decoder.write(encoded.slice(i, i + 1))
      maxBuffered = Math.max(maxBuffered, decoder._chunks.length)
    }
    t.ok(maxBuffered <= 6, 'only the current incomplete value remains buffered')
    decoder.end()
  })

  test('incomplete maps resume without decoding entries again' + suffix, opts, function (t) {
    t.plan(3)

    var pack = impl.msgpack()
    var decoder = pack.decoder()
    var data = {}
    var expected = {}
    var decodeCalls = 0
    var maxBuffered = 0
    var i

    function MyType (value) {
      this.value = value
    }

    pack.register(0x42, MyType, function (obj) {
      return Buffer.from([obj.value])
    }, function (buf) {
      decodeCalls++
      return buf.readUInt8(0)
    })

    // a map 16 of fixmaps, each holding one ext value
    for (i = 0; i < 100; i++) {
      data['k' + i] = { v: new MyType(i) }
      expected['k' + i] = { v: i }
    }

    decoder.on('data', function (result) {
      t.deepEqual(result, expected)
      t.equal(decodeCalls, 100, 'each completed entry is decoded once')
    })

    var encoded = pack.encode(data)
    for (i = 0; i < encoded.length; i++) {
      decoder.write(encoded.slice(i, i + 1))
      maxBuffered = Math.max(maxBuffered, decoder._chunks.length)
    }
    t.ok(maxBuffered <= 6, 'only the current incomplete value remains buffered')
    decoder.end()
  })

  test('values split across chunks decode the same as whole values' + suffix, opts, function (t) {
    var pack = impl.msgpack()
    var long = []
    var wide = {}
    var i

    for (i = 0; i < 20; i++) {
      long.push(i * 1000)
      wide['key' + i] = 'value ' + i
    }

    var data = [
      { hello: 'world', nested: { list: [1, [2, [3, []]], {}], flag: true }, nil: null },
      long,
      wide,
      [],
      {},
      'a string longer than thirty-one characters',
      [0.5, -1000, 12345678901, false, null],
      [[[[{ deep: [true, { deeper: [] }] }]]]],
      42
    ]
    var bytes = encodeAll(pack, data)
    var sizes = [1, 2, 3, 7, 64, bytes.length]

    series(sizes, function (size, next) {
      decodeInChunks(pack, bytes, size, function (timedOut, errors, decoded) {
        var label = ' (chunks of ' + size + ' bytes)'

        t.notOk(timedOut, 'decoder must not stall' + label)
        t.equal(errors.length, 0, 'must not error' + label)
        t.deepEqual(decoded, data, 'must decode every value' + label)
        next()
      })
    }, function () {
      t.end()
    })
  })

  test('limits nesting depth of containers split across chunks' + suffix, opts, function (t) {
    var containers = [
      { name: 'fixarray', header: [0x91] },
      { name: 'array 16', header: [0xdc, 0x00, 0x01] },
      { name: 'array 32', header: [0xdd, 0x00, 0x00, 0x00, 0x01] },
      { name: 'fixmap', header: [0x81, 0xa1, 0x78] },
      { name: 'map 16', header: [0xde, 0x00, 0x01, 0xa1, 0x78] }
    ]
    var cases = []

    containers.forEach(function (container) {
      cases.push({
        name: container.name + ' at the limit',
        pack: impl.msgpack(),
        bytes: nested(100, container.header),
        fails: false
      })
      cases.push({
        name: container.name + ' over the limit',
        pack: impl.msgpack(),
        bytes: nested(101, container.header),
        fails: true
      })
    })
    cases.push({
      name: 'over a custom limit',
      pack: impl.msgpack({ maxDepth: 2 }),
      bytes: nested(3, [0x91]),
      fails: true
    })

    series(cases, function (c, next) {
      decodeInChunks(c.pack, c.bytes, 1, function (timedOut, errors, decoded) {
        var label = ' (' + c.name + ')'

        t.notOk(timedOut, 'decoder must not stall' + label)
        if (c.fails) {
          t.equal(decoded.length, 0, 'must not emit decoded values' + label)
          t.equal(errors.length, 1, 'must emit one error' + label)
          t.equal(errors[0] && errors[0].message, 'Maximum decode depth exceeded', 'must report the depth limit' + label)
        } else {
          t.equal(errors.length, 0, 'must not error' + label)
          t.equal(decoded.length, 1, 'must decode the value' + label)
        }
        next()
      })
    }, function () {
      t.end()
    })
  })

  // { "__proto__": { "x": 1 } } followed by { "y": 2 }
  var protoPayload = [0x81, 0xa9].concat(
    '__proto__'.split('').map(function (c) { return c.charCodeAt(0) }),
    [0x81, 0xa1, 0x78, 0x01],
    [0x81, 0xa1, 0x79, 0x02]
  )

  test('rejects forbidden prototype properties split across chunks' + suffix, opts, function (t) {
    decodeInChunks(impl.msgpack(), protoPayload, 1, function (timedOut, errors, decoded) {
      t.notOk(timedOut, 'decoder must not stall')
      t.equal(decoded.length, 0, 'must not emit decoded values')
      t.equal(errors.length, 1, 'must emit one error')
      t.equal(errors[0] && errors[0].message, 'Object contains forbidden prototype property')
      t.equal({}.x, undefined, 'does not affect Object.prototype')
      t.end()
    })
  })

  test('removes forbidden prototype properties split across chunks' + suffix, opts, function (t) {
    decodeInChunks(impl.msgpack({ protoAction: 'remove' }), protoPayload, 1, function (timedOut, errors, decoded) {
      t.notOk(timedOut, 'decoder must not stall')
      t.equal(errors.length, 0, 'must not error')
      t.equal(decoded.length, 2, 'must decode every value')
      t.deepEqual(decoded[0], {}, 'must drop the forbidden property')
      t.equal(Object.getPrototypeOf(decoded[0]), Object.prototype, 'must keep the prototype')
      t.deepEqual(decoded[1], { y: 2 }, 'must decode the following value')
      t.equal({}.x, undefined, 'does not affect Object.prototype')
      t.end()
    })
  })

  test('decode ignores a second argument that is not a decode state' + suffix, opts, function (t) {
    var pack = impl.msgpack()
    var encoded = [pack.encode([1, 2]), pack.encode({ a: [3] })]

    t.deepEqual(encoded.map(pack.decode), [[1, 2], { a: [3] }], 'decodes when called with an index')
    t.deepEqual(pack.decode(pack.encode([4]), {}), [4], 'decodes when called with an object')
    t.end()
  })
})
