var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js
var require_addon_clipboard = __commonJS({
  "node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js"(exports, module) {
    !(function(t, e) {
      "object" == typeof exports && "object" == typeof module ? module.exports = e() : "function" == typeof define && define.amd ? define([], e) : "object" == typeof exports ? exports.ClipboardAddon = e() : t.ClipboardAddon = e();
    })(self, (() => (() => {
      var t = { 575: function(t2, e2, r2) {
        "undefined" != typeof self ? self : "undefined" != typeof window ? window : void 0 !== r2.g && r2.g, t2.exports = (function() {
          "use strict";
          var t3, e3 = "3.7.7", r3 = e3, n2 = "function" == typeof Buffer, o = "function" == typeof TextDecoder ? new TextDecoder() : void 0, i = "function" == typeof TextEncoder ? new TextEncoder() : void 0, u = Array.prototype.slice.call("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="), a = (t3 = {}, u.forEach((function(e4, r4) {
            return t3[e4] = r4;
          })), t3), c = /^(?:[A-Za-z\d+\/]{4})*?(?:[A-Za-z\d+\/]{2}(?:==)?|[A-Za-z\d+\/]{3}=?)?$/, f = String.fromCharCode.bind(String), s = "function" == typeof Uint8Array.from ? Uint8Array.from.bind(Uint8Array) : function(t4) {
            return new Uint8Array(Array.prototype.slice.call(t4, 0));
          }, d = function(t4) {
            return t4.replace(/=/g, "").replace(/[+\/]/g, (function(t5) {
              return "+" == t5 ? "-" : "_";
            }));
          }, l = function(t4) {
            return t4.replace(/[^A-Za-z0-9\+\/]/g, "");
          }, p = function(t4) {
            for (var e4, r4, n3, o2, i2 = "", a2 = t4.length % 3, c2 = 0; c2 < t4.length; ) {
              if ((r4 = t4.charCodeAt(c2++)) > 255 || (n3 = t4.charCodeAt(c2++)) > 255 || (o2 = t4.charCodeAt(c2++)) > 255) throw new TypeError("invalid character found");
              i2 += u[(e4 = r4 << 16 | n3 << 8 | o2) >> 18 & 63] + u[e4 >> 12 & 63] + u[e4 >> 6 & 63] + u[63 & e4];
            }
            return a2 ? i2.slice(0, a2 - 3) + "===".substring(a2) : i2;
          }, h = "function" == typeof btoa ? function(t4) {
            return btoa(t4);
          } : n2 ? function(t4) {
            return Buffer.from(t4, "binary").toString("base64");
          } : p, b = n2 ? function(t4) {
            return Buffer.from(t4).toString("base64");
          } : function(t4) {
            for (var e4 = [], r4 = 0, n3 = t4.length; r4 < n3; r4 += 4096) e4.push(f.apply(null, t4.subarray(r4, r4 + 4096)));
            return h(e4.join(""));
          }, y = function(t4, e4) {
            return void 0 === e4 && (e4 = false), e4 ? d(b(t4)) : b(t4);
          }, x = function(t4) {
            if (t4.length < 2) return (e4 = t4.charCodeAt(0)) < 128 ? t4 : e4 < 2048 ? f(192 | e4 >>> 6) + f(128 | 63 & e4) : f(224 | e4 >>> 12 & 15) + f(128 | e4 >>> 6 & 63) + f(128 | 63 & e4);
            var e4 = 65536 + 1024 * (t4.charCodeAt(0) - 55296) + (t4.charCodeAt(1) - 56320);
            return f(240 | e4 >>> 18 & 7) + f(128 | e4 >>> 12 & 63) + f(128 | e4 >>> 6 & 63) + f(128 | 63 & e4);
          }, A = /[\uD800-\uDBFF][\uDC00-\uDFFFF]|[^\x00-\x7F]/g, g = function(t4) {
            return t4.replace(A, x);
          }, v = n2 ? function(t4) {
            return Buffer.from(t4, "utf8").toString("base64");
          } : i ? function(t4) {
            return b(i.encode(t4));
          } : function(t4) {
            return h(g(t4));
          }, B = function(t4, e4) {
            return void 0 === e4 && (e4 = false), e4 ? d(v(t4)) : v(t4);
          }, C = function(t4) {
            return B(t4, true);
          }, m = /[\xC0-\xDF][\x80-\xBF]|[\xE0-\xEF][\x80-\xBF]{2}|[\xF0-\xF7][\x80-\xBF]{3}/g, w = function(t4) {
            switch (t4.length) {
              case 4:
                var e4 = ((7 & t4.charCodeAt(0)) << 18 | (63 & t4.charCodeAt(1)) << 12 | (63 & t4.charCodeAt(2)) << 6 | 63 & t4.charCodeAt(3)) - 65536;
                return f(55296 + (e4 >>> 10)) + f(56320 + (1023 & e4));
              case 3:
                return f((15 & t4.charCodeAt(0)) << 12 | (63 & t4.charCodeAt(1)) << 6 | 63 & t4.charCodeAt(2));
              default:
                return f((31 & t4.charCodeAt(0)) << 6 | 63 & t4.charCodeAt(1));
            }
          }, T = function(t4) {
            return t4.replace(m, w);
          }, _ = function(t4) {
            if (t4 = t4.replace(/\s+/g, ""), !c.test(t4)) throw new TypeError("malformed base64.");
            t4 += "==".slice(2 - (3 & t4.length));
            for (var e4, r4, n3, o2 = "", i2 = 0; i2 < t4.length; ) e4 = a[t4.charAt(i2++)] << 18 | a[t4.charAt(i2++)] << 12 | (r4 = a[t4.charAt(i2++)]) << 6 | (n3 = a[t4.charAt(i2++)]), o2 += 64 === r4 ? f(e4 >> 16 & 255) : 64 === n3 ? f(e4 >> 16 & 255, e4 >> 8 & 255) : f(e4 >> 16 & 255, e4 >> 8 & 255, 255 & e4);
            return o2;
          }, F = "function" == typeof atob ? function(t4) {
            return atob(l(t4));
          } : n2 ? function(t4) {
            return Buffer.from(t4, "base64").toString("binary");
          } : _, U = n2 ? function(t4) {
            return s(Buffer.from(t4, "base64"));
          } : function(t4) {
            return s(F(t4).split("").map((function(t5) {
              return t5.charCodeAt(0);
            })));
          }, P = function(t4) {
            return U(S(t4));
          }, j = n2 ? function(t4) {
            return Buffer.from(t4, "base64").toString("utf8");
          } : o ? function(t4) {
            return o.decode(U(t4));
          } : function(t4) {
            return T(F(t4));
          }, S = function(t4) {
            return l(t4.replace(/[-_]/g, (function(t5) {
              return "-" == t5 ? "+" : "/";
            })));
          }, E = function(t4) {
            return j(S(t4));
          }, R = function(t4) {
            return { value: t4, enumerable: false, writable: true, configurable: true };
          }, O = function() {
            var t4 = function(t5, e4) {
              return Object.defineProperty(String.prototype, t5, R(e4));
            };
            t4("fromBase64", (function() {
              return E(this);
            })), t4("toBase64", (function(t5) {
              return B(this, t5);
            })), t4("toBase64URI", (function() {
              return B(this, true);
            })), t4("toBase64URL", (function() {
              return B(this, true);
            })), t4("toUint8Array", (function() {
              return P(this);
            }));
          }, D = function() {
            var t4 = function(t5, e4) {
              return Object.defineProperty(Uint8Array.prototype, t5, R(e4));
            };
            t4("toBase64", (function(t5) {
              return y(this, t5);
            })), t4("toBase64URI", (function() {
              return y(this, true);
            })), t4("toBase64URL", (function() {
              return y(this, true);
            }));
          }, z = { version: e3, VERSION: r3, atob: F, atobPolyfill: _, btoa: h, btoaPolyfill: p, fromBase64: E, toBase64: B, encode: B, encodeURI: C, encodeURL: C, utob: g, btou: T, decode: E, isValid: function(t4) {
            if ("string" != typeof t4) return false;
            var e4 = t4.replace(/\s+/g, "").replace(/={0,2}$/, "");
            return !/[^\s0-9a-zA-Z\+/]/.test(e4) || !/[^\s0-9a-zA-Z\-_]/.test(e4);
          }, fromUint8Array: y, toUint8Array: P, extendString: O, extendUint8Array: D, extendBuiltins: function() {
            O(), D();
          }, Base64: {} };
          return Object.keys(z).forEach((function(t4) {
            return z.Base64[t4] = z[t4];
          })), z;
        })();
      } }, e = {};
      function r(n2) {
        var o = e[n2];
        if (void 0 !== o) return o.exports;
        var i = e[n2] = { exports: {} };
        return t[n2].call(i.exports, i, i.exports, r), i.exports;
      }
      r.g = (function() {
        if ("object" == typeof globalThis) return globalThis;
        try {
          return this || new Function("return this")();
        } catch (t2) {
          if ("object" == typeof window) return window;
        }
      })();
      var n = {};
      return (() => {
        "use strict";
        var t2 = n;
        Object.defineProperty(t2, "__esModule", { value: true }), t2.Base64 = t2.BrowserClipboardProvider = t2.ClipboardAddon = void 0;
        const e2 = r(575);
        t2.ClipboardAddon = class {
          constructor(t3 = new i(), e3 = new o()) {
            this._base64 = t3, this._provider = e3;
          }
          activate(t3) {
            this._terminal = t3, this._disposable = t3.parser.registerOscHandler(52, ((t4) => this._setOrReportClipboard(t4)));
          }
          dispose() {
            return this._disposable?.dispose();
          }
          _readText(t3, e3) {
            const r2 = this._base64.encodeText(e3);
            this._terminal?.input(`\x1B]52;${t3};${r2}\x07`, false);
          }
          _setOrReportClipboard(t3) {
            const e3 = t3.split(";");
            if (e3.length < 2) return true;
            const r2 = e3[0], n2 = e3[1];
            if ("?" === n2) {
              const t4 = this._provider.readText(r2);
              return t4 instanceof Promise ? t4.then(((t5) => (this._readText(r2, t5), true))) : (this._readText(r2, t4), true);
            }
            let o2 = "";
            try {
              o2 = this._base64.decodeText(n2);
            } catch {
            }
            const i2 = this._provider.writeText(r2, o2);
            return !(i2 instanceof Promise) || i2.then((() => true));
          }
        };
        class o {
          async readText(t3) {
            return "c" !== t3 ? Promise.resolve("") : navigator.clipboard.readText();
          }
          async writeText(t3, e3) {
            return "c" !== t3 ? Promise.resolve() : navigator.clipboard.writeText(e3);
          }
        }
        t2.BrowserClipboardProvider = o;
        class i {
          encodeText(t3) {
            return e2.Base64.encode(t3);
          }
          decodeText(t3) {
            const r2 = e2.Base64.decode(t3);
            return e2.Base64.isValid(t3) && e2.Base64.encode(r2) === t3 ? r2 : "";
          }
        }
        t2.Base64 = i;
      })(), n;
    })()));
  }
});
var __mod = require_addon_clipboard();
export const ClipboardAddon = __mod.ClipboardAddon;
export default __mod;
