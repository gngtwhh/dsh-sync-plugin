/**
 * 设置页 RPC 契约自测：直接调用 createApiHandler，验证请求/响应形状，不需要浏览器。
 * 运行：node test/api.mjs
 */
import { createApiHandler } from '../index.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  }
}

const calls = []
const state = []
const run = async (action, payload) => {
  calls.push({ action, payload })
  if (action === 'explode') throw new Error('boom')
  return { action, status: 'ok' }
}
const engine = { writeState: async (patch) => state.push(patch) }
const handler = createApiHandler({ run, engine })

function post(body) {
  return new Request('http://127.0.0.1:28049/api/dsh-sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const statusResponse = await handler(post({ action: 'status' }), { principal: { kind: 'owner' } })
const statusBody = await statusResponse.json()
check('status 返回 200 与 ok:true', statusResponse.status === 200 && statusBody.ok === true, statusBody)
check('status 透传数据', statusBody.data && statusBody.data.status === 'ok')
check('status 附带文字摘要', typeof statusBody.summary === 'string' && statusBody.summary.includes('目标：'), statusBody.summary)

await handler(post({ action: 'push' }), { principal: { kind: 'owner' } })
check('push 转发到同一实现', calls.at(-1).action === 'push', calls)

const emptyResponse = await handler(post({}), { principal: { kind: 'owner' } })
check('缺省 action 当作 status', (await emptyResponse.json()).ok === true && calls.at(-1).action === 'status')

const brokenResponse = await handler(post('not json'), { principal: { kind: 'owner' } })
check('坏 JSON 退化为 status', (await brokenResponse.json()).ok === true)

const failureResponse = await handler(post({ action: 'explode' }), { principal: { kind: 'owner' } })
const failureBody = await failureResponse.json()
check('失败返回 500 与原因', failureResponse.status === 500 && failureBody.error === 'boom', failureBody)
check('失败写入 lastError', state.at(-1) && state.at(-1).lastError === 'boom', state)

const forbidden = await handler(post({ action: 'status' }), { principal: { kind: 'api' } })
check('非 owner 返回 403', forbidden.status === 403)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个用例失败`)
process.exitCode = failures === 0 ? 0 : 1
