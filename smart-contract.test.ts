import {TxParams} from '@zilliqa-js/account'
import {BN, bytes, Long} from '@zilliqa-js/util'
import {Zilliqa} from '@zilliqa-js/zilliqa'
import {readFileSync} from 'fs'
import {readdirSync} from 'fs'
import * as hashjs from 'hash.js'
import * as KayaProvider from 'kaya-cli/src/provider'
import {basename, join} from 'path'
import * as uuid from 'uuid/v4'
import {
  contract_info as auction_registrar_contract_info,
} from './contract_info/auction_registrar.json'
import {
  contract_info as marketplace_contract_info,
} from './contract_info/marketplace.json'
import {
  contract_info as registry_contract_info,
} from './contract_info/registry.json'
import {
  contract_info as resolver_contract_info,
} from './contract_info/resolver.json'
import {
  contract_info as simple_registrar_contract_info,
} from './contract_info/simple_registrar.json'
import {generateMapperFromContractInfo} from './lib/params'
import {checker} from './lib/scilla'

const auctionRegistrarData = generateMapperFromContractInfo(
  auction_registrar_contract_info,
)
const marketplaceData = generateMapperFromContractInfo(
  marketplace_contract_info,
)
const registryData = generateMapperFromContractInfo(registry_contract_info)
const resolverData = generateMapperFromContractInfo(resolver_contract_info)
const simpleRegistrarData = generateMapperFromContractInfo(
  simple_registrar_contract_info,
)

const version = bytes.pack(111, 1)

const defaultParams: TxParams = {
  version,
  toAddr: '0x' + '0'.repeat(40),
  amount: new BN(0),
  gasPrice: new BN(1000000000),
  gasLimit: Long.fromNumber(25000),
}

function deployMarketplace(
  zilliqa: Zilliqa,
  {registry, seller, _creation_block = '0'},
  params: Partial<TxParams> = {},
) {
  return zilliqa.contracts
    .new(
      readFileSync('./scilla/marketplace.scilla', 'utf8'),
      marketplaceData.init({registry, seller}).concat({
        vname: '_creation_block',
        type: 'BNum',
        value: _creation_block.toString(),
      }),
    )
    .deploy({...defaultParams, ...params})
}

function deployRegistry(
  zilliqa: Zilliqa,
  {initialOwner, _creation_block = '0'},
  params: Partial<TxParams> = {},
) {
  return zilliqa.contracts
    .new(
      readFileSync('./scilla/registry.scilla', 'utf8'),
      registryData.init({initialOwner}).concat({
        vname: '_creation_block',
        type: 'BNum',
        value: _creation_block.toString(),
      }),
    )
    .deploy({...defaultParams, ...params})
}

function deploySimpleRegistrar(
  zilliqa: Zilliqa,
  {
    registry,
    ownedNode,
    owner,
    initialDefaultPrice, // = 1,
    initialLiPerUSD, // 0.017 * 10 ** 12,
    _creation_block = '0',
  },
  params: Partial<TxParams> = {},
) {
  return zilliqa.contracts
    .new(
      readFileSync('./scilla/simple_registrar.scilla', 'utf8'),
      simpleRegistrarData
        .init({
          registry,
          ownedNode,
          owner,
          initialDefaultPrice,
          initialLiPerUSD,
        })
        .concat({
          vname: '_creation_block',
          type: 'BNum',
          value: _creation_block.toString(),
        }),
    )
    .deploy({...defaultParams, ...params})
}

function deployAuctionRegistrar(
  zilliqa: Zilliqa,
  {
    owner,
    registry,
    ownedNode,
    initialAuctionLength,
    minimumAuctionLength,
    initialDefaultPrice,
    bidIncrementNumerator,
    bidIncrementDenominator,
    initialPricePerLi,
    initialMaxPriceUSD,
    _creation_block = '0',
  },
  params: Partial<TxParams> = {},
) {
  return zilliqa.contracts
    .new(
      readFileSync('./scilla/auction_registrar.scilla', 'utf8'),
      auctionRegistrarData
        .init({
          owner,
          registry,
          ownedNode,
          initialAuctionLength,
          minimumAuctionLength,
          initialDefaultPrice,
          bidIncrementNumerator,
          bidIncrementDenominator,
          initialPricePerLi,
          initialMaxPriceUSD,
        })
        .concat({
          vname: '_creation_block',
          type: 'BNum',
          value: _creation_block.toString(),
        }),
    )
    .deploy({...defaultParams, ...params})
}

function deployResolver(
  zilliqa: Zilliqa,
  {owner, _creation_block = '0'},
  params: Partial<TxParams> = {},
) {
  return zilliqa.contracts
    .new(
      readFileSync('./scilla/resolver.scilla', 'utf8'),
      resolverData.init({owner}).concat({
        vname: '_creation_block',
        type: 'BNum',
        value: _creation_block.toString(),
      }),
    )
    .deploy({...defaultParams, ...params})
}

function sha256(buffer) {
  return Buffer.from(
    hashjs
      .sha256()
      .update(buffer)
      .digest(),
  )
}

function namehash(name) {
  if (name.match(/^0x\d+$/)) {
    return name
  }
  let node = Buffer.alloc(32, 0)

  if (name) {
    let labels = name.split('.')

    for (let i = labels.length - 1; i >= 0; i--) {
      node = sha256(Buffer.concat([node, sha256(labels[i])]))
    }
  }

  return '0x' + node.toString('hex')
}

const contractField = async (contract, name) => {
  const field = (await contract.getState()).find(v => v.vname === name)
  if (!field) {
    throw new Error(`Unknown contract field ${name}`)
  }
  return field.value
}

const contractMapValue = async (contract, field, key) => {
  const map = await contractField(contract, field)
  const record = map.find(r => r.key == key) || null
  return record && record.val
}

const getRegistryRecord = async (registry, domain) => {
  const node = namehash(domain)
  return await contractMapValue(registry, 'records', node)
}

const ownerOf = async (registry, domain) => {
  const record = await getRegistryRecord(registry, domain)
  return record && record.arguments[0].replace(/^0x/, '')
}

const resolverOf = async (registry, domain) => {
  const record = await getRegistryRecord(registry, domain)
  return record && record.arguments[1].replace(/^0x/, '')
}

const resolverRecords = async resolver => {
  const records = await contractField(resolver, 'records')
  return records.reduce((a, v) => ({...a, [v.key]: v.val}), {})
}

const approvalOf = async (registry, domain) => {
  const node = namehash(domain)
  const approval = await contractMapValue(registry, 'approvals', node)
  return approval && approval.replace(/^0x/, '')
}

const address = 'd90f2e538ce0df89c8273cad3b63ec44a3c4ed82'
const privateKey =
  'e53d1c3edaffc7a7bab5418eb836cf75819a82872b4a1a0f1c7fcf5c3e020b89'
const address2 = '2f4f79ef6abfc0368f5a7e2c2df82e1afdfe7204'
const privateKey2 =
  '1234567890123456789012345678901234567890123456789012345678901234'

const rootNode = '0x' + '0'.repeat(64)
const nullAddress = '0'.repeat(40)

xdescribe('checks', () => {
  for (const input of readdirSync(join(process.cwd(), 'scilla'))
    .map(v => join(process.cwd(), 'scilla', v))
    .filter(v => v.endsWith('.scilla'))) {
    it(`should successfully type-check ${basename(input)}`, () =>
      checker({input}))
  }
})

describe('smart contracts', () => {
  let provider
  beforeEach(() => {
    jest.resetModules()

    const id = uuid()

    provider = new KayaProvider(
      {dataPath: `/tmp/kaya_${id}_`},
      {
        // 1,000,000,000 ZIL
        [address]: {privateKey, amount: '1000000000000000000000', nonce: 0},
        [address2]: {
          privateKey: privateKey2,
          amount: '1000000000000000000000',
          nonce: 0,
        },
      },
    )
  })

  describe('resolver.scilla', () => {
    it('should deploy', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [resolverTx, resolver] = await deployResolver(zilliqa, {
        owner: '0x' + address,
      })
      expect(resolverTx.isConfirmed()).toBeTruthy()
      expect(await resolver.getInit()).toHaveLength(4)
    })

    it('should set and unset records', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))
      const [, resolver] = await deployResolver(zilliqa, {
        owner: '0x' + address,
      })

      //////////////////////////////////////////////////////////////////////////
      // set record
      //////////////////////////////////////////////////////////////////////////

      await resolver.call(
        'set',
        resolverData.f.set({key: 'test', value: '0x7357'}),
        defaultParams,
      )

      expect(await resolverRecords(resolver)).toEqual({test: '0x7357'})

      //////////////////////////////////////////////////////////////////////////
      // unset record
      //////////////////////////////////////////////////////////////////////////

      await resolver.call(
        'unset',
        resolverData.f.unset({key: 'test'}),
        defaultParams,
      )

      expect(await resolverRecords(resolver)).toEqual({})
    })

    it('should fail to set and unset records if sender not owner', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))
      const [, resolver] = await deployResolver(zilliqa, {
        owner: '0x' + address,
      })

      //////////////////////////////////////////////////////////////////////////
      // fail to set record using bad address
      //////////////////////////////////////////////////////////////////////////

      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey2))

      await resolver.call(
        'set',
        resolverData.f.set({key: 'test', value: '0x7357'}),
        defaultParams,
      )
      expect(await resolverRecords(resolver)).toEqual({})

      //////////////////////////////////////////////////////////////////////////
      // set record then fail to unset record using bad address
      //////////////////////////////////////////////////////////////////////////

      zilliqa.wallet.setDefault(address)

      await resolver.call(
        'set',
        resolverData.f.set({key: 'test', value: '0x7357'}),
        defaultParams,
      )

      expect(await resolverRecords(resolver)).toEqual({test: '0x7357'})

      zilliqa.wallet.setDefault(address2)

      await resolver.call(
        'unset',
        resolverData.f.unset({key: 'test'}),
        defaultParams,
      )
      expect(await resolverRecords(resolver)).toEqual({test: '0x7357'})
    })

    it("should gracefully fail to unset records if they don't exist", async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))
      const [, resolver] = await deployResolver(zilliqa, {
        owner: '0x' + address,
      })

      //////////////////////////////////////////////////////////////////////////
      // shouldn't do anything
      //////////////////////////////////////////////////////////////////////////

      await resolver.call(
        'unset',
        resolverData.f.unset({key: 'does_not_exist'}),
        defaultParams,
      )

      expect(await resolverRecords(resolver)).toEqual({})
    })
  })

  describe('registry.scilla', () => {
    it('should deploy', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [registryTx, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )
      expect(registryTx.isConfirmed()).toBeTruthy()
      expect(await registry.getInit()).toHaveLength(4)
    })

    it('should approve addresses and set and unset operators for addresses', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )

      //////////////////////////////////////////////////////////////////////////
      // approve normally
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'approve',
        registryData.f.approve({node: rootNode, address: '0x' + address2}),
        defaultParams,
      )

      expect(await approvalOf(registry, rootNode)).toEqual(address2)

      //////////////////////////////////////////////////////////////////////////
      // approve null address
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'approve',
        registryData.f.approve({
          node: rootNode,
          address: '0x' + nullAddress,
        }),
        defaultParams,
      )
      expect(await approvalOf(registry, rootNode)).toEqual(nullAddress)

      //////////////////////////////////////////////////////////////////////////
      // fail to approve node owned by someone else
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'approve',
        registryData.f.approve({
          node: namehash('node-owned-by-someone-else'),
          address: '0x' + address2,
        }),
        defaultParams,
      )

      expect(await approvalOf(registry, 'node-owned-by-someone-else')).toEqual(
        null,
      )

      //////////////////////////////////////////////////////////////////////////
      // add operator
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'approveFor',
        registryData.f.approveFor({
          address: '0x' + address2,
          isApproved: {constructor: 'True', argtypes: [], arguments: []},
        }),
        defaultParams,
      )

      expect(
        await await contractMapValue(
          registry,
          'operators',
          '0xd90f2e538ce0df89c8273cad3b63ec44a3c4ed82',
        ),
      ).toEqual(['0x2f4f79ef6abfc0368f5a7e2c2df82e1afdfe7204'])

      //////////////////////////////////////////////////////////////////////////
      // remove operator
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'approveFor',
        registryData.f.approveFor({
          address: '0x' + address2,
          isApproved: {constructor: 'False', argtypes: [], arguments: []},
        }),
        defaultParams,
      )
      expect(
        await contractMapValue(
          registry,
          'operators',
          '0xd90f2e538ce0df89c8273cad3b63ec44a3c4ed82',
        ),
      ).toEqual([])
    })

    it('should add and remove admins if currently admin', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )

      //////////////////////////////////////////////////////////////////////////
      // add admin
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'setAdmin',
        registryData.f.setAdmin({
          address: '0x' + address2,
          isApproved: {constructor: 'True', argtypes: [], arguments: []},
        }),
        defaultParams,
      )

      expect(await contractField(registry, 'admins')).toEqual([
        '0x' + address2,
        '0x' + address,
      ])

      //////////////////////////////////////////////////////////////////////////
      // remove admin
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'setAdmin',
        registryData.f.setAdmin({
          address: '0x' + address2,
          isApproved: {constructor: 'False', argtypes: [], arguments: []},
        }),
        defaultParams,
      )

      expect(await contractField(registry, 'admins')).toEqual(['0x' + address])

      //////////////////////////////////////////////////////////////////////////
      // fail to set admin using bad address
      //////////////////////////////////////////////////////////////////////////

      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey2))

      await registry.call(
        'setAdmin',
        registryData.f.setAdmin({
          address: '0x' + address2,
          isApproved: {constructor: 'True', argtypes: [], arguments: []},
        }),
        defaultParams,
      )

      expect(await contractField(registry, 'admins')).toEqual(['0x' + address])
    })

    it('should freely configure names properly', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )

      //////////////////////////////////////////////////////////////////////////
      // configure resolver
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'configureResolver',
        registryData.f.configureResolver({
          node: rootNode,
          resolver: '0x' + address2,
        }),
        defaultParams,
      )

      expect(await resolverOf(registry, rootNode)).toEqual(address2)
      expect(await ownerOf(registry, rootNode)).toEqual(address)

      //////////////////////////////////////////////////////////////////////////
      // configure node
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'configureNode',
        registryData.f.configureNode({
          node: rootNode,
          owner: '0x' + address2,
          resolver: '0x' + address2,
        }),
        defaultParams,
      )

      expect(await resolverOf(registry, rootNode)).toEqual(address2)
      expect(await ownerOf(registry, rootNode)).toEqual(address2)

      //////////////////////////////////////////////////////////////////////////
      // fail to configure resolver using bad address
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'configureResolver',
        registryData.f.configureResolver({
          node: rootNode,
          resolver: '0x' + address,
        }),
        defaultParams,
      )

      expect(await resolverOf(registry, rootNode)).toEqual(address2)
      expect(await ownerOf(registry, rootNode)).toEqual(address2)

      //////////////////////////////////////////////////////////////////////////
      // fail to configure node using bad address
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'configureNode',
        registryData.f.configureNode({
          node: rootNode,
          owner: '0x' + address,
          resolver: '0x' + address,
        }),
        defaultParams,
      )
      expect(await resolverOf(registry, rootNode)).toEqual(address2)
      expect(await ownerOf(registry, rootNode)).toEqual(address2)
    })

    it('should freely transfer names properly', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )

      //////////////////////////////////////////////////////////////////////////
      // approve address to check transfer
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'approve',
        registryData.f.approve({node: rootNode, address: '0x' + address}),
        defaultParams,
      )

      await registry.call(
        'transfer',
        registryData.f.transfer({
          node: rootNode,
          owner: '0x' + address2,
        }),
        defaultParams,
      )

      expect(await ownerOf(registry, rootNode)).toEqual(address2)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)

      //////////////////////////////////////////////////////////////////////////
      // fail to transfer using bad address
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'transfer',
        registryData.f.transfer({
          node: rootNode,
          owner: '0x' + address,
        }),
        defaultParams,
      )

      expect(await ownerOf(registry, rootNode)).toEqual(address2)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
    })

    it('should freely assign names properly', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )

      //////////////////////////////////////////////////////////////////////////
      // assign subdomain
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'approve',
        registryData.f.approve({node: rootNode, address: '0x' + address}),
        defaultParams,
      )

      await registry.call(
        'assign',
        registryData.f.assign({
          parent: rootNode,
          label: 'tld',
          owner: '0x' + address,
        }),
        defaultParams,
      )
      expect(await ownerOf(registry, rootNode)).toEqual(address)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
      expect(await ownerOf(registry, 'tld')).toEqual(address)
      expect(await resolverOf(registry, 'tld')).toEqual(nullAddress)

      //////////////////////////////////////////////////////////////////////////
      // assign owned subdomain
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'assign',
        registryData.f.assign({
          parent: rootNode,
          label: 'tld',
          owner: '0x' + address2,
        }),
        defaultParams,
      )
      expect(await ownerOf(registry, rootNode)).toEqual(address)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
      expect(await ownerOf(registry, 'tld')).toEqual(address2)
      expect(await resolverOf(registry, 'tld')).toEqual(nullAddress)

      //////////////////////////////////////////////////////////////////////////
      // fail to assign subdomain using bad address
      //////////////////////////////////////////////////////////////////////////

      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey2))

      await registry.call(
        'assign',
        registryData.f.assign({
          parent: rootNode,
          label: 'tld',
          owner: '0x' + address2,
        }),
        defaultParams,
      )

      expect(await ownerOf(registry, rootNode)).toEqual(address)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
      expect(await ownerOf(registry, 'tld')).toEqual(address2)
      expect(await resolverOf(registry, 'tld')).toEqual(nullAddress)
    })

    it('should freely bestow names properly', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )

      //////////////////////////////////////////////////////////////////////////
      // bestow name
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'bestow',
        registryData.f.bestow({
          parent: rootNode,
          label: 'tld',
          owner: '0x' + address,
          resolver: '0x' + address,
        }),
        defaultParams,
      )

      expect(await ownerOf(registry, rootNode)).toEqual(address)
      expect(await ownerOf(registry, 'tld')).toEqual(address)
      expect(await ownerOf(registry, 'unknown')).toEqual(null)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
      expect(await resolverOf(registry, 'tld')).toEqual(address)
      expect(await resolverOf(registry, 'unknown')).toEqual(null)

      //////////////////////////////////////////////////////////////////////////
      // fail to bestow owned name
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'bestow',
        registryData.f.bestow({
          parent: rootNode,
          label: 'tld',
          owner: '0x' + address2,
          resolver: '0x' + address2,
        }),
        defaultParams,
      )

      expect(await ownerOf(registry, 'tld')).toEqual(address)
      expect(await resolverOf(registry, 'tld')).toEqual(address)

      //////////////////////////////////////////////////////////////////////////
      // fail to bestow owned using bad address
      //////////////////////////////////////////////////////////////////////////

      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey2))

      await registry.call(
        'bestow',
        registryData.f.bestow({
          parent: rootNode,
          label: 'other-tld',
          owner: '0x' + address2,
          resolver: '0x' + address2,
        }),
        defaultParams,
      )
      expect(await ownerOf(registry, 'other-tld')).toEqual(null)
      expect(await resolverOf(registry, 'other-tld')).toEqual(null)
    })

    it('should allow admins to set registrar', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )

      //////////////////////////////////////////////////////////////////////////
      // set registrar address
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'setRegistrar',
        registryData.f.setRegistrar({address: '0x' + address2}),
        defaultParams,
      )

      expect(await contractField(registry, 'registrar')).toEqual(
        '0x' + address2,
      )

      //////////////////////////////////////////////////////////////////////////
      // fail to set registrar address using bad address
      //////////////////////////////////////////////////////////////////////////

      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey2))

      await registry.call(
        'setRegistrar',
        registryData.f.setRegistrar({address: '0x' + address}),
        defaultParams,
      )

      expect(await contractField(registry, 'registrar')).toEqual(
        '0x' + address2,
      )
    })
  })

  describe('simple_registrar.scilla', () => {
    it('should deploy', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [registrarTx, registrar] = await deploySimpleRegistrar(
        zilliqa,
        {
          registry: '0x' + '0'.repeat(40),
          owner: '0x' + '0'.repeat(40),
          ownedNode: rootNode,
          initialDefaultPrice: '1',
          initialLiPerUSD: '1',
        },
        {gasLimit: Long.fromNumber(100000)},
      )
      expect(registrarTx.isConfirmed()).toBeTruthy()
      expect(await registrar.getInit()).toHaveLength(8)
    })

    it('should register name', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )

      const [, registrar] = await deploySimpleRegistrar(
        zilliqa,
        {
          registry: '0x' + registry.address,
          owner: '0x' + address,
          ownedNode: rootNode,
          initialDefaultPrice: '1',
          initialLiPerUSD: '1',
        },
        {gasLimit: Long.fromNumber(100000)},
      )

      await registry.call(
        'setRegistrar',
        registryData.f.setRegistrar({address: '0x' + registrar.address}),
        defaultParams,
      )

      //////////////////////////////////////////////////////////////////////////
      // register name
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'register',
        registryData.f.register({parent: rootNode, label: 'name'}),
        {
          ...defaultParams,
          amount: new BN(1),
        },
      )

      expect(await ownerOf(registry, rootNode)).toEqual(address)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
      expect(await ownerOf(registry, 'name')).toEqual(address)
      expect(await resolverOf(registry, 'name')).toEqual(nullAddress)

      //////////////////////////////////////////////////////////////////////////
      // fail to register name using bad amount
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'register',
        registryData.f.register({parent: rootNode, label: 'not-enough-funds'}),
        defaultParams,
      )

      expect(await ownerOf(registry, rootNode)).toEqual(address)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
      expect(await ownerOf(registry, 'name')).toEqual(address)
      expect(await resolverOf(registry, 'name')).toEqual(nullAddress)

      //////////////////////////////////////////////////////////////////////////
      // fail to register name using owned name
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'register',
        registryData.f.register({parent: rootNode, label: 'name'}),
        {
          ...defaultParams,
          amount: new BN(1),
        },
      )

      expect(await ownerOf(registry, rootNode)).toEqual(address)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
      expect(await ownerOf(registry, 'name')).toEqual(address)
      expect(await resolverOf(registry, 'name')).toEqual(nullAddress)

      //////////////////////////////////////////////////////////////////////////
      // fail to register name using bad sender
      //////////////////////////////////////////////////////////////////////////

      await registrar.call(
        'register',
        simpleRegistrarData.f.register({
          node: namehash('bad-sender'),
          parent: rootNode,
          label: 'bad-sender',
          origin: '0x' + address,
        }),
        {
          ...defaultParams,
          amount: new BN(1),
        },
      )

      expect(await ownerOf(registry, rootNode)).toEqual(address)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
      expect(await ownerOf(registry, 'name')).toEqual(address)
      expect(await resolverOf(registry, 'name')).toEqual(nullAddress)
      expect(await ownerOf(registry, 'bad-sender')).toEqual(null)
      expect(await resolverOf(registry, 'bad-sender')).toEqual(null)
    })
  })

  describe('auction_registrar.scilla', () => {
    it('should deploy', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [registrarTx, registrar] = await deployAuctionRegistrar(
        zilliqa,
        {
          owner: '0x' + '0'.repeat(40),
          registry: '0x' + '0'.repeat(40),
          ownedNode: rootNode,
          initialAuctionLength: '1',
          minimumAuctionLength: '1',
          initialDefaultPrice: '1',
          bidIncrementNumerator: '1',
          bidIncrementDenominator: '100',
          initialPricePerLi: '100',
          initialMaxPriceUSD: '1000',
        },
        {gasLimit: Long.fromNumber(100000)},
      )
      expect(registrarTx.isConfirmed()).toBeTruthy()
      expect(await registrar.getInit()).toHaveLength(13)
    })

    it('should start, bid and end auction', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )

      const [, registrar] = await deployAuctionRegistrar(
        zilliqa,
        {
          owner: '0x' + address,
          registry: '0x' + registry.address,
          ownedNode: rootNode,
          initialAuctionLength: '3',
          minimumAuctionLength: '2',
          initialDefaultPrice: '100',
          bidIncrementNumerator: '1',
          bidIncrementDenominator: '100',
          initialPricePerLi: '1',
          initialMaxPriceUSD: '1000',
        },
        {gasLimit: Long.fromNumber(100000)},
      )

      await registry.call(
        'setRegistrar',
        registryData.f.setRegistrar({address: '0x' + registrar.address}),
        defaultParams,
      )

      //////////////////////////////////////////////////////////////////////////
      // run auctions
      //////////////////////////////////////////////////////////////////////////

      await registrar.call(
        'setRunning',
        auctionRegistrarData.f.setRunning({
          newRunning: {constructor: 'True', argtypes: [], arguments: []},
        }),
        defaultParams,
      )

      expect(await contractField(registrar, 'running')).toMatchObject({
        constructor: 'True',
        argtypes: [],
        arguments: [],
      })

      //////////////////////////////////////////////////////////////////////////
      // open an auction
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'register',
        registryData.f.register({parent: rootNode, label: 'name'}),
        {
          ...defaultParams,
          amount: new BN(200),
        },
      )

      expect(await ownerOf(registry, rootNode)).toEqual(address)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
      expect(await ownerOf(registry, 'name')).toEqual(registrar.address)
      expect(await resolverOf(registry, 'name')).toEqual(nullAddress)

      expect(
        await contractMapValue(registrar, 'auctions', namehash('name')),
      ).toMatchObject({
        constructor: 'Auction',
        argtypes: [],
        arguments: [
          '0x' + address,
          '200',
          expect.stringMatching(/^\d+$/),
          'name',
        ],
      })

      //////////////////////////////////////////////////////////////////////////
      // bid on an auction
      //////////////////////////////////////////////////////////////////////////

      await registrar.call(
        'bid',
        auctionRegistrarData.f.bid({node: namehash('name')}),
        {...defaultParams, amount: new BN(300)},
      )

      expect(
        await contractMapValue(registrar, 'auctions', namehash('name')),
      ).toMatchObject({
        constructor: 'Auction',
        argtypes: [],
        arguments: [
          '0x' + address,
          '300',
          expect.stringMatching(/^\d*$/),
          'name',
        ],
      })

      //////////////////////////////////////////////////////////////////////////
      // close an auction
      //////////////////////////////////////////////////////////////////////////

      await zilliqa.provider.send('KayaMine')
      await zilliqa.provider.send('KayaMine')
      await zilliqa.provider.send('KayaMine')
      await zilliqa.provider.send('KayaMine') // {result: '4'}

      await registrar.call(
        'close',
        auctionRegistrarData.f.close({node: namehash('name')}),
        defaultParams,
      )

      expect(await ownerOf(registry, rootNode)).toEqual(address)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
      expect(await ownerOf(registry, 'name')).toEqual(address)
      expect(await resolverOf(registry, 'name')).toEqual(nullAddress)

      expect(await contractField(registrar, 'auctions')).toHaveLength(0)

      //////////////////////////////////////////////////////////////////////////
      // close an auction on register
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'register',
        registryData.f.register({parent: rootNode, label: 'registered-name'}),
        {
          ...defaultParams,
          amount: new BN(2000),
        },
      )

      expect(await ownerOf(registry, rootNode)).toEqual(address)
      expect(await resolverOf(registry, rootNode)).toEqual(nullAddress)
      expect(await ownerOf(registry, 'name')).toEqual(address)
      expect(await resolverOf(registry, 'name')).toEqual(nullAddress)
      expect(await ownerOf(registry, 'registered-name')).toEqual(address)
      expect(await resolverOf(registry, 'registered-name')).toEqual(nullAddress)

      expect(await contractField(registrar, 'auctions')).toHaveLength(0)

      //////////////////////////////////////////////////////////////////////////
      // close an auction on bid
      //////////////////////////////////////////////////////////////////////////

      await registry.call(
        'register',
        registryData.f.register({parent: rootNode, label: 'bid-name'}),
        {
          ...defaultParams,
          amount: new BN(200),
        },
      )

      await registrar.call(
        'bid',
        auctionRegistrarData.f.bid({node: namehash('bid-name')}),
        {...defaultParams, amount: new BN(2000)},
      )

      await zilliqa.provider.send('KayaMine')

      await registrar.call(
        'close',
        auctionRegistrarData.f.close({node: namehash('bid-name')}),
        defaultParams,
      )

      expect(await ownerOf(registry, 'bid-name')).toEqual(address)
      expect(await resolverOf(registry, 'bid-name')).toEqual(nullAddress)

      expect(await contractField(registrar, 'auctions')).toHaveLength(0)
    })
  })

  fdescribe('marketplace.scilla', () => {
    it('should deploy', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [marketplaceTx, marketplace] = await deployMarketplace(zilliqa, {
        registry: '0x' + '0'.repeat(40),
        seller: '0x' + '0'.repeat(40),
      })

      expect(marketplaceTx.isConfirmed()).toBeTruthy()
      expect(await marketplace.getInit()).toHaveLength(5)
    })

    it('should enable buying and selling of names', async () => {
      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )

      const [, marketplace] = await deployMarketplace(zilliqa, {
        registry: '0x' + registry.address,
        seller: '0x' + address,
      })

      await registry.call(
        'approveFor',
        registryData.f.approveFor({
          address: '0x' + marketplace.address,
          isApproved: {constructor: 'True', argtypes: [], arguments: []},
        }),
        defaultParams,
      )

      await marketplace.call(
        'offer',
        marketplaceData.f.offer({node: rootNode, price: '1'}),
        defaultParams,
      )

      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey2))

      await marketplace.call(
        'buy',
        marketplaceData.f.buy({node: rootNode, seller: '0x' + address}),
        {
          ...defaultParams,
          amount: new BN('1'),
        },
      )

      expect(await ownerOf(registry, rootNode)).toBe(address2)
      expect(await approvalOf(registry, rootNode)).toBe(nullAddress)
    })
  })

  xdescribe('integration and pre-configuration', () => {
    const records = {
      // null: null,
      // empty: {},
      // emptyfields: {
      //   ADA: '',
      //   BCH: '',
      //   BTC: '',
      //   EOS: '',
      //   ETH: '',
      //   LTC: '',
      //   XLM: '',
      //   XRP: '',
      //   ZIL: '',
      // },
      partial: {
        ADA:
          'DL4pHtsfecWgzp5PQdzFs21sM4rhtFzCqtR25aAyrieSFzzXM8X4Cqw3JvdQaQLdLUbr5K4ZtHNbKNcrdV41X5tewCqdrAFmPEJDQU9G',
        BTC: '1PZGBAB8ZwXb5i8gp3GCfnmqVTseUVEM5g',
        ETH: '0x7cf734b3ebb3c580895b2dcd924f59482308d34b',
        LTC: 'LM26kiNqvnDkeqhno8Kdz8VLJmXdg4wrr9',
        ZIL: '0x5b2db3ebb3c5808cd924f59482308d7cf734934b',
      },
      onlyzil: {
        ZIL: '0xd924f59482308d7c5b2db3ebb3c5808cf734934b',
      },
      full: {
        ADA: 'Ae2tdPwUZuDdLb8UPEZEfFiSoXYGQAYSSZeShobxMEihLM6ewWvVV8NyGrX',
        BCH: '1McTmk6CqPWMkgzdkUiVSx6mwiWVixVrx8',
        BTC: '1Ej6SdCyfacpvpRGsiSWmfNaFxnVzgsjyk',
        EOS: 'EOS7dsws9He6jM8FQGPNmFr3xj8UtFCGtb1eEm5gaTAagMAWZhUme',
        ETH: '0xE5b4528144d22C395D42d8a212E70a8F90F8ba7f',
        LTC: 'LUknCgSJtq3iwuhtK886Jie5iMbhocfxBT',
        XLM: 'GACJCWYIUHQ6FLVNF45MNYE4WOEXOLWVFHBP5SIMUN3UWZJNOZRR5YZA',
        XRP: 'rUZ8iNVUY96YuCfGEv2Ntm6oK9PEG8gZZa',
        ZIL: '0x7cbff0c4b4cDCC94cdf9f97d0D05e774424f81AE',
      },
    }

    const randomAddress = () =>
      '0x' +
      new Array(40)
        .fill('')
        .map(() => Math.floor(Math.random() * 16).toString(16))
        .join('')

    const users = {
      1: {
        names: Object.keys(records).slice(0, 2),
        zilAddress: randomAddress(),
        resolverAddress: null,
      },
      2: {
        names: Object.keys(records).slice(2),
        zilAddress: randomAddress(),
        resolverAddress: null,
      },
    }

    xit('should deploy and pre-configure correctly', async () => {
      // 1. deploy registry.scilla
      //      Easy enough
      // 2. pre-configure owners to be on admin addresses.
      //      See code generation in pre-configured-resolver.
      // https://github.com/Zilliqa/Zilliqa-JavaScript-Library/tree/dev/packages/zilliqa-js-crypto#tobech32addressaddress-string-string
      // 4. set-up endpoint where user supplies Zilliqa address, we set owner on
      //    resolver to be correct ZIL address

      // 5. dust for backup. operators etc...

      // This is pseudo code for the endpoint

      /* for (const name of user.names) {
        const node = namehash(name)

        // This actually needs to be a call to the tx processor
        await registry.call(
          'configureNode',
          registryData.f.configureNode({
            owner: zilClaimAdderss,
            resolver: user.resolver,
            node,
          }),
          defaultParams,
        )

        // Something like this
        return res.json({
          id: await txProcessor.send(
            'zil',
            zilliqa.transactions.new({
              ...defaultParams,
              toAddr: registry.address,
              data: {
                _tag: 'configureNode',
                params: registryData.f.configureNode({
                  owner: zilClaimAdderss,
                  resolver: user.resolver,
                  node,
                }),
              },
            }),
          ),
        })
      } */

      // Tenative table for deployment
      // id | description | ctime | status

      // txQueue
      //   .send(
      //     'zil',
      //     zilliqa.wallet.signWith(
      //       zilliqa.transactions.new({
      //         // bla bla bla
      //       }),
      //       address,
      //     ),
      //   )
      //   .on('error', error => {
      //     //
      //   })
      //   .on('pending', tx => {
      //     //
      //   })
      //   .on('busy', tx => {
      //     //
      //   })
      //   .on('success', tx => {
      //     //
      //   })

      const zilliqa = new Zilliqa(null, provider)
      zilliqa.wallet.setDefault(zilliqa.wallet.addByPrivateKey(privateKey))

      const [, registry] = await deployRegistry(
        zilliqa,
        {initialOwner: '0x' + address},
        {gasLimit: Long.fromNumber(100000)},
      )

      for (const [, {names, zilAddress}] of Object.entries(users)) {
        for (const name of names) {
          if (records[name] /* && Object.keys(records[name]).length > 0 */) {
            const [, resolver] = await deployResolver(zilliqa, {
              owner: '0x' + address,
            })

            console.log('resolver.address', resolver.address)

            const fullName = name + '.zil'
            const node = namehash(fullName)

            await registry.call(
              'bestow',
              registryData.f.bestow({
                parent: namehash('zil'),
                label: name,
                owner: zilAddress,
                resolver: '0x' + resolver.address,
              }),
              defaultParams,
            )

            for (const [ticker, value] of Object.entries(records[name])) {
              console.log('value:', value)
              await resolver.call(
                'set',
                resolverData.f.set({
                  node,
                  key: `crypto.${ticker}`,
                  value:
                    '0x' + Buffer.from(value as any, 'utf8').toString('hex'),
                }),
                defaultParams,
              )
            }

            console.log(
              '%s: %o',
              fullName,
              await contractMapValue(registry, 'records', node),
            )

            console.log('%s: %o', fullName, await resolver.getState())
          }
        }

        // await resolver.call(
        //   'setOwner',
        //   resolverData.f.setOwner({newOwner: zilAddress}),
        //   defaultParams,
        // )
      }

      // console.log('%o', await contractField(registry, 'records'))
    })
  })
})