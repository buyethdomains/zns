import * as _ from 'lodash';

function normalizeValue(value) {
  switch(typeof(value)) {
    case "number": return value.toString()
    case "boolean":
      return {constructor: value ? "True" : "False", argtypes: [], arguments: []}
    case "object":
      if (value instanceof Array) {
        return value;
      }
      if (_.isObject(value)) {
        return _.map(value, (val, key) => ({key, val}))
      }
      return value
    case "string":
      return value.match(/0x[0-9a-f]+/i) ? value.toLowerCase() : value;
    default:       return value.toString()
  }
}
function generateMapperForParams(params) {
  return (values) => {
    return params.map((v, i) => {
      return ({...v, value: normalizeValue(values[v.vname])})
    })
  }
}

let defaultParams = [
  {
    vname: '_scilla_version',
    type: 'Uint32',
  },
]
let defaultValues = {
  _scilla_version: 0,
}

export function generateMapperFromContractInfo(info) {
  const initMapper = generateMapperForParams(info.params.concat(defaultParams))

  return {
    init: (values) => {
      return initMapper({...defaultValues, ...values})
    },
    f: info.transitions.reduce(
      (a, v) => ({...a, [v.vname]: generateMapperForParams(v.params)}),
      {},
    ),
  }
}

