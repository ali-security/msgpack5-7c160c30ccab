var bl = require('bl')
var util = require('util')

function IncompleteBufferError (message) {
  Error.call(this) // super constructor
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, this.constructor) // super helper method to include stack trace in error object
  }
  this.name = this.constructor.name
  this.message = message || 'unable to decode'
}

util.inherits(IncompleteBufferError, Error)

module.exports = function buildDecode (decodingTypes, options) {
  var maxDepth = options.maxDepth === undefined ? 100 : options.maxDepth
  if (typeof maxDepth !== 'number' || !isFinite(maxDepth) || Math.floor(maxDepth) !== maxDepth || maxDepth < 0) {
    throw new TypeError('maxDepth must be a non-negative integer')
  }

  return decode

  function getSize (first) {
    switch (first) {
      case 0xc4:
        return 2
      case 0xc5:
        return 3
      case 0xc6:
        return 5
      case 0xc7:
        return 3
      case 0xc8:
        return 4
      case 0xc9:
        return 6
      case 0xca:
        return 5
      case 0xcb:
        return 9
      case 0xcc:
        return 2
      case 0xcd:
        return 3
      case 0xce:
        return 5
      case 0xcf:
        return 9
      case 0xd0:
        return 2
      case 0xd1:
        return 3
      case 0xd2:
        return 5
      case 0xd3:
        return 9
      case 0xd4:
        return 3
      case 0xd5:
        return 4
      case 0xd6:
        return 6
      case 0xd7:
        return 10
      case 0xd8:
        return 18
      case 0xd9:
        return 2
      case 0xda:
        return 3
      case 0xdb:
        return 5
      case 0xde:
        return 3
      default:
        return -1
    }
  }

  function hasMinBufferSize (first, length) {
    var size = getSize(first)

    if (size !== -1 && length < size) {
      return false
    } else {
      return true
    }
  }

  function isValidDataSize (dataLength, bufLength, headerLength) {
    return bufLength >= headerLength + dataLength
  }

  function buildDecodeResult (value, bytesConsumed) {
    return {
      value: value,
      bytesConsumed: bytesConsumed
    }
  }

  function decode (buf, decodeState) {
    if (!(buf instanceof bl)) {
      buf = bl().append(buf)
    }

    // the stream Decoder passes its decodeState, so that a container split
    // across chunks is resumed where the previous chunk left it instead of
    // being decoded again from its first element on every chunk
    var incremental = isDecodeState(decodeState)
    var result
    try {
      result = incremental
        ? tryDecodeIncremental(buf, decodeState)
        : tryDecode(buf, 0, 0)
    } catch (err) {
      if (incremental) decodeState.stack.length = 0
      throw err
    }

    if (result) {
      if (!incremental) buf.consume(result.bytesConsumed)
      return result.value
    } else {
      throw new IncompleteBufferError()
    }
  }

  function isDecodeState (state) {
    return state !== null && typeof state === 'object' && Array.isArray(state.stack)
  }

  // Decodes the next value of `buf`, consuming every completed element as it
  // goes: the containers still open are kept on `state.stack` together with
  // the elements decoded so far, so the next call carries on from there.
  function tryDecodeIncremental (buf, state) {
    while (buf.length > 0) {
      var container = decodeContainerHeader(buf)
      var value

      if (container === null) return null

      if (container) {
        if (state.stack.length + 1 > maxDepth) {
          throw new Error('Maximum decode depth exceeded')
        }

        buf.consume(container.headerLength)

        var itemCount = container.type === 'map'
          ? 2 * container.length
          : container.length

        if (itemCount > 0) {
          state.stack.push({
            type: container.type,
            length: container.length,
            itemCount: itemCount,
            result: []
          })
          continue
        }

        value = container.type === 'map'
          ? buildMap([], 0)
          : []
      } else {
        var result = tryDecode(buf, 0, state.stack.length)
        if (!result) return null

        buf.consume(result.bytesConsumed)
        value = result.value
      }

      var completed = completeIncrementalValue(state, value)
      if (completed) return completed
    }

    return null
  }

  function completeIncrementalValue (state, value) {
    while (state.stack.length > 0) {
      var frame = state.stack[state.stack.length - 1]
      frame.result.push(value)

      if (frame.result.length < frame.itemCount) return null

      state.stack.pop()
      value = frame.type === 'map'
        ? buildMap(frame.result, frame.length)
        : frame.result
    }

    return buildDecodeResult(value, 0)
  }

  // Returns the header of the array or map starting `buf`, null when that
  // header is incomplete, or false when `buf` does not start with a container
  // this decoder can resume (map 32 is left to tryDecode, which rejects it).
  function decodeContainerHeader (buf) {
    var first = buf.readUInt8(0)

    if ((first & 0xf0) === 0x80) {
      return { type: 'map', length: first & 0x0f, headerLength: 1 }
    }
    if ((first & 0xf0) === 0x90) {
      return { type: 'array', length: first & 0x0f, headerLength: 1 }
    }

    var headerLength
    if (first === 0xdc || first === 0xde) headerLength = 3
    if (first === 0xdd) headerLength = 5
    if (!headerLength) return false
    if (buf.length < headerLength) return null

    return {
      type: first === 0xde ? 'map' : 'array',
      length: headerLength === 3 ? buf.readUInt16BE(1) : buf.readUInt32BE(1),
      headerLength: headerLength
    }
  }

  // Builds a map out of its decoded keys and values, interleaved in `items`
  function buildMap (items, length) {
    var result = {}
    var key
    var i

    for (i = 0; i < 2 * length; i += 2) {
      key = items[i]

      if (key === '__proto__') {
        if (options.protoAction === 'error') {
          throw new SyntaxError('Object contains forbidden prototype property')
        }

        if (options.protoAction === 'remove') {
          continue
        }
      }

      result[key] = items[i + 1]
    }

    return result
  }

  function tryDecode (buf, offset, depth) {
    offset = offset === undefined ? 0 : offset
    var bufLength = buf.length - offset
    if (bufLength <= 0) {
      return null
    }

    var first = buf.readUInt8(offset)
    var length
    var result = 0
    var type
    var bytePos

    if (!hasMinBufferSize(first, bufLength)) {
      return null
    }

    if (first === 0xc1) throw new Error('0xc1 is a reserved MessagePack byte')

    switch (first) {
      case 0xc0:
        return buildDecodeResult(null, 1)
      case 0xc2:
        return buildDecodeResult(false, 1)
      case 0xc3:
        return buildDecodeResult(true, 1)
      case 0xcc:
        // 1-byte unsigned int
        result = buf.readUInt8(offset + 1)
        return buildDecodeResult(result, 2)
      case 0xcd:
        // 2-bytes BE unsigned int
        result = buf.readUInt16BE(offset + 1)
        return buildDecodeResult(result, 3)
      case 0xce:
        // 4-bytes BE unsigned int
        result = buf.readUInt32BE(offset + 1)
        return buildDecodeResult(result, 5)
      case 0xcf:
        // 8-bytes BE unsigned int
        // Read long byte by byte, big-endian
        for (bytePos = 7; bytePos >= 0; bytePos--) {
          result += (buf.readUInt8(offset + bytePos + 1) * Math.pow(2, (8 * (7 - bytePos))))
        }
        return buildDecodeResult(result, 9)
      case 0xd0:
        // 1-byte signed int
        result = buf.readInt8(offset + 1)
        return buildDecodeResult(result, 2)
      case 0xd1:
        // 2-bytes signed int
        result = buf.readInt16BE(offset + 1)
        return buildDecodeResult(result, 3)
      case 0xd2:
        // 4-bytes signed int
        result = buf.readInt32BE(offset + 1)
        return buildDecodeResult(result, 5)
      case 0xd3:
        result = readInt64BE(buf, offset + 1)
        return buildDecodeResult(result, 9)
      case 0xca:
        // 4-bytes float
        result = buf.readFloatBE(offset + 1)
        return buildDecodeResult(result, 5)
      case 0xcb:
        // 8-bytes double
        result = buf.readDoubleBE(offset + 1)
        return buildDecodeResult(result, 9)
      case 0xd9:
        // strings up to 2^8 - 1 bytes
        length = buf.readUInt8(offset + 1)
        if (!isValidDataSize(length, bufLength, 2)) {
          return null
        }
        result = buf.toString('utf8', offset + 2, offset + 2 + length)
        return buildDecodeResult(result, 2 + length)
      case 0xda:
        // strings up to 2^16 - 2 bytes
        length = buf.readUInt16BE(offset + 1)
        if (!isValidDataSize(length, bufLength, 3)) {
          return null
        }
        result = buf.toString('utf8', offset + 3, offset + 3 + length)
        return buildDecodeResult(result, 3 + length)
      case 0xdb:
        // strings up to 2^32 - 4 bytes
        length = buf.readUInt32BE(offset + 1)
        if (!isValidDataSize(length, bufLength, 5)) {
          return null
        }
        result = buf.toString('utf8', offset + 5, offset + 5 + length)
        return buildDecodeResult(result, 5 + length)
      case 0xc4:
        // buffers up to 2^8 - 1 bytes
        length = buf.readUInt8(offset + 1)
        if (!isValidDataSize(length, bufLength, 2)) {
          return null
        }
        result = buf.slice(offset + 2, offset + 2 + length)
        return buildDecodeResult(result, 2 + length)
      case 0xc5:
        // buffers up to 2^16 - 1 bytes
        length = buf.readUInt16BE(offset + 1)
        if (!isValidDataSize(length, bufLength, 3)) {
          return null
        }
        result = buf.slice(offset + 3, offset + 3 + length)
        return buildDecodeResult(result, 3 + length)
      case 0xc6:
        // buffers up to 2^32 - 1 bytes
        length = buf.readUInt32BE(offset + 1)
        if (!isValidDataSize(length, bufLength, 5)) {
          return null
        }
        result = buf.slice(offset + 5, offset + 5 + length)
        return buildDecodeResult(result, 5 + length)
      case 0xdc:
        // array up to 2^16 elements - 2 bytes
        if (bufLength < 3) {
          return null
        }

        length = buf.readUInt16BE(offset + 1)
        return decodeArray(buf, offset, length, 3, depth + 1)
      case 0xdd:
        // array up to 2^32 elements - 4 bytes
        if (bufLength < 5) {
          return null
        }

        length = buf.readUInt32BE(offset + 1)
        return decodeArray(buf, offset, length, 5, depth + 1)
      case 0xde:
        // maps up to 2^16 elements - 2 bytes
        length = buf.readUInt16BE(offset + 1)
        return decodeMap(buf, offset, length, 3, depth + 1)
      case 0xdf:
        throw new Error('map too big to decode in JS')
      case 0xd4:
        return decodeFixExt(buf, offset, 1)
      case 0xd5:
        return decodeFixExt(buf, offset, 2)
      case 0xd6:
        return decodeFixExt(buf, offset, 4)
      case 0xd7:
        return decodeFixExt(buf, offset, 8)
      case 0xd8:
        return decodeFixExt(buf, offset, 16)
      case 0xc7:
        // ext up to 2^8 - 1 bytes
        length = buf.readUInt8(offset + 1)
        type = buf.readUInt8(offset + 2)
        if (!isValidDataSize(length, bufLength, 3)) {
          return null
        }
        return decodeExt(buf, offset, type, length, 3)
      case 0xc8:
        // ext up to 2^16 - 1 bytes
        length = buf.readUInt16BE(offset + 1)
        type = buf.readUInt8(offset + 3)
        if (!isValidDataSize(length, bufLength, 4)) {
          return null
        }
        return decodeExt(buf, offset, type, length, 4)
      case 0xc9:
        // ext up to 2^32 - 1 bytes
        length = buf.readUInt32BE(offset + 1)
        type = buf.readUInt8(offset + 5)
        if (!isValidDataSize(length, bufLength, 6)) {
          return null
        }
        return decodeExt(buf, offset, type, length, 6)
    }

    if ((first & 0xf0) === 0x90) {
      // we have an array with less than 15 elements
      length = first & 0x0f
      return decodeArray(buf, offset, length, 1, depth + 1)
    } else if ((first & 0xf0) === 0x80) {
      // we have a map with less than 15 elements
      length = first & 0x0f
      return decodeMap(buf, offset, length, 1, depth + 1)
    } else if ((first & 0xe0) === 0xa0) {
      // fixstr up to 31 bytes
      length = first & 0x1f
      if (isValidDataSize(length, bufLength, 1)) {
        result = buf.toString('utf8', offset + 1, offset + length + 1)
        return buildDecodeResult(result, length + 1)
      } else {
        return null
      }
    } else if (first >= 0xe0) {
      // 5 bits negative ints
      result = first - 0x100
      return buildDecodeResult(result, 1)
    } else if (first < 0x80) {
      // 7-bits positive ints
      return buildDecodeResult(first, 1)
    } else {
      throw new Error('not implemented yet')
    }
  }

  function readInt64BE (buf, offset) {
    var negate = (buf.readUInt8(offset) & 0x80) === 0x80
    var hi = buf.readUInt32BE(offset + 0)
    var lo = buf.readUInt32BE(offset + 4)

    if (negate) {
      lo = (~lo + 1) >>> 0
      hi = (~hi + (lo === 0 ? 1 : 0)) >>> 0
    }

    return (hi * 4294967296 + lo) * (negate ? -1 : +1)
  }

  function decodeArray (buf, offset, length, headerLength, depth) {
    if (depth > maxDepth) {
      throw new Error('Maximum decode depth exceeded')
    }

    var result = []
    var i
    var totalBytesConsumed = 0

    offset += headerLength
    for (i = 0; i < length; i++) {
      var decodeResult = tryDecode(buf, offset, depth)
      if (decodeResult) {
        result.push(decodeResult.value)
        offset += decodeResult.bytesConsumed
        totalBytesConsumed += decodeResult.bytesConsumed
      } else {
        return null
      }
    }
    return buildDecodeResult(result, headerLength + totalBytesConsumed)
  }

  function decodeMap (buf, offset, length, headerLength, depth) {
    if (depth > maxDepth) {
      throw new Error('Maximum decode depth exceeded')
    }

    var result = {}
    var key
    var i
    var totalBytesConsumed = 0

    offset += headerLength
    for (i = 0; i < length; i++) {
      var keyResult = tryDecode(buf, offset, depth)
      if (keyResult) {
        offset += keyResult.bytesConsumed
        var valueResult = tryDecode(buf, offset, depth)
        if (valueResult) {
          key = keyResult.value

          if (key === '__proto__') {
            if (options.protoAction === 'error') {
              throw new SyntaxError('Object contains forbidden prototype property')
            }

            if (options.protoAction === 'remove') {
              continue
            }
          }

          result[key] = valueResult.value
          offset += valueResult.bytesConsumed
          totalBytesConsumed += (keyResult.bytesConsumed + valueResult.bytesConsumed)
        } else {
          return null
        }
      } else {
        return null
      }
    }
    return buildDecodeResult(result, headerLength + totalBytesConsumed)
  }

  function decodeFixExt (buf, offset, size) {
    var type = buf.readUInt8(offset + 1)

    return decodeExt(buf, offset, type, size, 2)
  }

  function decodeExt (buf, offset, type, size, headerSize) {
    var i,
      toDecode

    offset += headerSize
    for (i = 0; i < decodingTypes.length; i++) {
      if (type === decodingTypes[i].type) {
        toDecode = buf.slice(offset, offset + size)
        var value = decodingTypes[i].decode(toDecode)
        return buildDecodeResult(value, headerSize + size)
      }
    }

    throw new Error('unable to find ext type ' + type)
  }
}

module.exports.IncompleteBufferError = IncompleteBufferError
