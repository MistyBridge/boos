# server.js 拆分方案

> 日期: 2026-07-13 | 现状: 2311 行 | 目标: 15 个文件，每文件 ≤150 行

---

## 当前路由清单 (40 个处理器)

```
行 47:   app.use(express.json)
行 57:   app.use(CORS)
行 134:  app.use(deviceGate)
行 142:  app.use(remoteGuard)
──────────────────────────────
行 175:  GET  /api/dev/ping              } dev (dev mode only)
行 176:  GET  /api/dev/reload            }
──────────────────────────────
行 682:  GET  /api/config                } config
行 686:  PUT  /api/config                }
行 703:  POST /api/clis/test             }
──────────────────────────────
行 781:  GET  /api/folders               } folders
行 787:  POST /api/folders               }
行 793:  PUT  /api/folders/:id           }
行 799:  DELETE /api/folders/:id         }
行 811:  POST /api/folders/reorder       }
──────────────────────────────
行 820:  GET  /api/sessions              } sessions (core)
行 844:  GET  /api/sessions/deleted      }
行 849:  PUT  /api/sessions/:id          }
行 861:  POST /api/sessions/:id/switch-cli}
行 893:  POST /api/sessions/:id/stop     }
行 909:  DELETE /api/sessions/:id        }
行 917:  POST /api/sessions/:id/restore  }
行 940:  POST /api/sessions/:id/open-editor}
行 969:  POST /api/sessions/reorder      }
──────────────────────────────
行 1119: POST /api/sessions/new          } sessions/launch (最复杂)
行 1256: POST /api/sessions/:id/resume   }
行 1307: POST /api/sessions/:id/resume-picker}
行 1330: GET  /api/cli-sessions          }
行 1375: POST /api/sessions/import-by-id }
行 1438: POST /api/sessions/adopt        }
──────────────────────────────
行 986:  GET  /api/browse                } workspaces
行 1024: GET  /api/workspaces            }
行 1044: DELETE /api/workspaces/:name    }
行 1075: GET  /api/workspaces/:name/layout}
行 1090: PUT  /api/workspaces/:name/layout}
──────────────────────────────
行 1509: GET  /api/capabilities          } health
行 1516: GET  /api/health                }
行 1525: POST /api/heartbeat             }
行 1531: POST /api/spawn-browser         }
行 1536: POST /api/shutdown              }
行 ?:    POST /api/restart               }
──────────────────────────────
行 ?:    GET  /api/version               } version
行 ?:    POST /api/upgrade               }
──────────────────────────────
行 13:   GET  /api/tunnel/status         } tunnel
行 16:   POST /api/tunnel/start          }
行 29:   POST /api/tunnel/stop           }
行 33:   POST /api/tunnel/token          }
行 46:   POST /api/tunnel/autostart      }
行 62:   POST /api/tunnel/install        }
行 75:   POST /api/tunnel/devtunnel/login}
行 84:   POST /api/tunnel/devtunnel/login/cancel}
行 87:   POST /api/tunnel/devtunnel/login/dismiss}
行 97:   POST /api/tunnel/devtunnel/reset}
──────────────────────────────
行 111:  GET  /api/devices/me            } devices
行 137:  GET  /api/devices               }
行 140:  POST /api/devices/:id/approve   }
行 145:  POST /api/devices/:id/reject    }
行 150:  POST /api/devices/:id/revoke    }
行 155:  PUT  /api/devices/:id           }
行 160:  DELETE /api/devices/:id         }
──────────────────────────────
行 2188: WebSocket /ws/terminal/:id       } terminal
```

---

## 拆分方案

### 目标结构

```
server.js                    (~80 行: app 组装 + 启动 + gracefulShutdown)
lib/
├── middleware.js             (~60 行: asyncH, cors, remoteGuard, deviceGate)
├── atomicJson.js            (已修复 ✅)
├── persistedSessions.js     (不变)
├── ... (其他 lib 文件不变)
routes/
├── sessions.js              (~120 行: CRUD)
├── sessions-launch.js       (~150 行: new/resume/adopt/import)
├── folders.js               (~70 行)
├── workspaces.js            (~90 行: workspaces + browse)
├── config.js                (~50 行)
├── health.js                (~50 行: health + heartbeat + capabilities + browser + shutdown)
├── version.js               (~80 行: version + upgrade + restart)
├── tunnel.js                (~100 行)
├── devices.js               (~90 行)
├── dev.js                   (~25 行: dev-only routes)
└── terminal.js              (~50 行: WebSocket upgrade)
```

### 逐文件拆分

#### `lib/middleware.js` (新建)

```js
// 从 server.js 提取:
// - asyncH(fn)            ← 异步错误包装器
// - ALLOWED_ORIGINS       ← CORS 白名单常量
// - corsMiddleware         ← 行 57-72
// - deviceGate            ← 行 134-140
// - remoteGuard           ← 行 142-166
module.exports = { asyncH, corsMiddleware, deviceGate, remoteGuard, ALLOWED_ORIGINS };
```

#### `routes/sessions.js` (~120 行)

| 方法 | 路径 | 依赖 |
|------|------|------|
| GET | `/api/sessions` | persistedSessions.loadAll |
| GET | `/api/sessions/deleted` | persistedSessions.loadDeleted |
| PUT | `/api/sessions/:id` | persistedSessions.update |
| POST | `/api/sessions/:id/switch-cli` | persistedSessions.update |
| POST | `/api/sessions/:id/stop` | webTerminal.kill, persistedSessions |
| DELETE | `/api/sessions/:id` | webTerminal.kill, persistedSessions.drop |
| POST | `/api/sessions/:id/restore` | persistedSessions.restore |
| POST | `/api/sessions/:id/open-editor` | child_process.exec |
| POST | `/api/sessions/reorder` | persistedSessions.reorder |

#### `routes/sessions-launch.js` (~150 行) ← 最复杂

| 方法 | 路径 | 依赖 |
|------|------|------|
| POST | `/api/sessions/new` | workspace, webTerminal, persistedSessions, sessionBinding |
| POST | `/api/sessions/:id/resume` | persistedSessions, webTerminal, localCliSessions |
| POST | `/api/sessions/:id/resume-picker` | 同上 |
| POST | `/api/sessions/import-by-id` | localCliSessions, persistedSessions |
| POST | `/api/sessions/adopt` | persistedSessions, localCliSessions |
| GET | `/api/cli-sessions` | localCliSessions.list |

#### `routes/folders.js` (~70 行)

#### `routes/workspaces.js` (~90 行)

#### `routes/config.js` (~50 行)

#### `routes/health.js` (~50 行)

#### `routes/version.js` (~80 行)

#### `routes/tunnel.js` (~100 行)

#### `routes/devices.js` (~90 行)

#### `routes/dev.js` (~25 行)

#### `routes/terminal.js` (~50 行)

#### `server.js` (重构后, ~80 行)

```js
// 仅负责:
// 1. require express + 中间件
// 2. require 所有 routes/ 并注册
// 3. gracefulShutdown()
// 4. listen()
```

---

## 实施策略

### Phase 1: 抽离中间件 (安全, 不改行为)
1. 创建 `lib/middleware.js`, 搬移 `asyncH` + CORS + deviceGate + remoteGuard
2. server.js 改为 `require('./lib/middleware')`
3. 验证: `node server.js` 启动无报错

### Phase 2: 逐路由文件迁移 (每次一个)
顺序: dev → health → config → folders → workspaces → sessions → sessions-launch → version → tunnel → devices → terminal
原则: 每步可独立测试

### Phase 3: 清理 server.js
删空旧路由, server.js 仅剩组装

---

## 验收标准

- [ ] 所有 40 个路由处理器正常工作
- [ ] `npm start` 启动时间不变 (当前 ~200ms)
- [ ] WebSocket `/ws/terminal/:id` 正常桥接
- [ ] NDJSON stream (`/api/sessions/new`) 不断流
- [ ] CORS + remoteGuard 中间件生效
- [ ] 每个 routes/ 文件 ≤150 行
