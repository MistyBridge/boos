// Sprint 42: 统一错误上报 — 禁止静默失败
//
// 用户决策 (2026-08-06): 系统中所有错误必须附带报错信息，不允许静默。
// 所有 catch {} / 静默 return / .catch(() => {}) 必须改为走本模块。
//
// 用法:
//   const errReport = require('../errorReport');          // lib/ 下
//   const errReport = require('../../errorReport');       // lib/agentBus/ 下
//   catch (e) { errReport.report('webTerminal', 'write', e, { sessionId }); }
//   if (!entry) return errReport.skip('webTerminal', 'write', 'no pty entry', { sessionId });
//
// 原则:
//   1. report()  — 真正的异常：必带 module:op + 错误信息 + 可选上下文
//   2. skip()    — 条件不满足的静默 return：记录跳过原因（warn 级）
//   3. 节流      — 同一 (module,op) 每秒最多 1 条，防止循环日志刷屏
//   4. 从不 throw — 上报不改变原有控制流（调用方自己决定是否抛出）

'use strict';

const THROTTLE_MS = 1000;

const lastByKey = new Map();

function throttle(key) {
  const now = Date.now();
  const last = lastByKey.get(key) || 0;
  if (now - last < THROTTLE_MS) return true;
  lastByKey.set(key, now);
  return false;
}

function fmtErr(err) {
  if (err == null) return '(no error object)';
  if (err instanceof Error) return err.message + (err.stack ? '\n  ' + err.stack.split('\n').slice(0, 3).join('\n  ') : '');
  try { return JSON.stringify(err); } catch { return String(err); }
}

function fmtExtra(extra) {
  if (extra == null) return '';
  try { return ' | ' + JSON.stringify(extra); } catch { return ' | ' + String(extra); }
}

/**
 * 上报一个被捕获的异常。附带 module:op、错误对象、可选上下文。
 * 节流：同 (module,op) 每秒最多打一条，后续合并计数。
 */
function report(module, op, err, extra) {
  const key = module + ':' + op;
  const suffix = fmtExtra(extra);
  if (throttle(key)) return;
  console.error(`[err] ${key} — ${fmtErr(err)}${suffix}`);
}

/**
 * 条件不满足导致的静默 return —— 记录跳过原因（warn 级）。
 * 用于原本 `if (!x) return;` 且无日志的路径。
 */
function skip(module, op, reason, extra) {
  const key = module + ':' + op;
  const suffix = fmtExtra(extra);
  if (throttle(key)) return;
  console.warn(`[warn] ${key} — skipped: ${reason}${suffix}`);
}

/**
 * 异步 rejection 的兜底上报：`p.catch((e) => errReport.reject('m', 'op', e))`
 */
function reject(module, op, err, extra) {
  report(module, op, err || new Error('unhandled rejection'), extra);
}

module.exports = { report, skip, reject };
