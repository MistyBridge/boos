var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// node_modules/@xterm/addon-serialize/lib/addon-serialize.js
var require_addon_serialize = __commonJS({
  "node_modules/@xterm/addon-serialize/lib/addon-serialize.js"(exports, module) {
    !(function(t, e) {
      "object" == typeof exports && "object" == typeof module ? module.exports = e() : "function" == typeof define && define.amd ? define([], e) : "object" == typeof exports ? exports.SerializeAddon = e() : t.SerializeAddon = e();
    })(globalThis, (() => (() => {
      "use strict";
      var t = { 992: (t2, e2, s2) => {
        Object.defineProperty(e2, "__esModule", { value: true }), e2.DEFAULT_ANSI_COLORS = void 0;
        const r2 = s2(993);
        e2.DEFAULT_ANSI_COLORS = Object.freeze((() => {
          const t3 = [r2.css.toColor("#2e3436"), r2.css.toColor("#cc0000"), r2.css.toColor("#4e9a06"), r2.css.toColor("#c4a000"), r2.css.toColor("#3465a4"), r2.css.toColor("#75507b"), r2.css.toColor("#06989a"), r2.css.toColor("#d3d7cf"), r2.css.toColor("#555753"), r2.css.toColor("#ef2929"), r2.css.toColor("#8ae234"), r2.css.toColor("#fce94f"), r2.css.toColor("#729fcf"), r2.css.toColor("#ad7fa8"), r2.css.toColor("#34e2e2"), r2.css.toColor("#eeeeec")], e3 = [0, 95, 135, 175, 215, 255];
          for (let s3 = 0; s3 < 216; s3++) {
            const i = e3[s3 / 36 % 6 | 0], o = e3[s3 / 6 % 6 | 0], n = e3[s3 % 6];
            t3.push({ css: r2.channels.toCss(i, o, n), rgba: r2.channels.toRgba(i, o, n) });
          }
          for (let e4 = 0; e4 < 24; e4++) {
            const s3 = 8 + 10 * e4;
            t3.push({ css: r2.channels.toCss(s3, s3, s3), rgba: r2.channels.toRgba(s3, s3, s3) });
          }
          return t3;
        })());
      }, 993: (t2, e2) => {
        Object.defineProperty(e2, "__esModule", { value: true }), e2.rgba = e2.rgb = e2.css = e2.color = e2.channels = e2.NULL_COLOR = void 0, e2.toPaddedHex = c, e2.contrastRatio = _;
        let s2 = 0, r2 = 0, i = 0, o = 0;
        var n, l, a, u, h;
        function c(t3) {
          const e3 = t3.toString(16);
          return e3.length < 2 ? "0" + e3 : e3;
        }
        function _(t3, e3) {
          return t3 < e3 ? (e3 + 0.05) / (t3 + 0.05) : (t3 + 0.05) / (e3 + 0.05);
        }
        e2.NULL_COLOR = { css: "#00000000", rgba: 0 }, (function(t3) {
          t3.toCss = function(t4, e3, s3, r3) {
            return void 0 !== r3 ? `#${c(t4)}${c(e3)}${c(s3)}${c(r3)}` : `#${c(t4)}${c(e3)}${c(s3)}`;
          }, t3.toRgba = function(t4, e3, s3, r3 = 255) {
            return (t4 << 24 | e3 << 16 | s3 << 8 | r3) >>> 0;
          }, t3.toColor = function(e3, s3, r3, i2) {
            return { css: t3.toCss(e3, s3, r3, i2), rgba: t3.toRgba(e3, s3, r3, i2) };
          };
        })(n || (e2.channels = n = {})), (function(t3) {
          function e3(t4, e4) {
            return o = Math.round(255 * e4), [s2, r2, i] = h.toChannels(t4.rgba), { css: n.toCss(s2, r2, i, o), rgba: n.toRgba(s2, r2, i, o) };
          }
          t3.blend = function(t4, e4) {
            if (o = (255 & e4.rgba) / 255, 1 === o) return { css: e4.css, rgba: e4.rgba };
            const l2 = e4.rgba >> 24 & 255, a2 = e4.rgba >> 16 & 255, u2 = e4.rgba >> 8 & 255, h2 = t4.rgba >> 24 & 255, c2 = t4.rgba >> 16 & 255, _2 = t4.rgba >> 8 & 255;
            return s2 = h2 + Math.round((l2 - h2) * o), r2 = c2 + Math.round((a2 - c2) * o), i = _2 + Math.round((u2 - _2) * o), { css: n.toCss(s2, r2, i), rgba: n.toRgba(s2, r2, i) };
          }, t3.isOpaque = function(t4) {
            return !(255 & ~t4.rgba);
          }, t3.ensureContrastRatio = function(t4, e4, s3) {
            const r3 = h.ensureContrastRatio(t4.rgba, e4.rgba, s3);
            if (r3) return n.toColor(r3 >> 24 & 255, r3 >> 16 & 255, r3 >> 8 & 255);
          }, t3.opaque = function(t4) {
            const e4 = (255 | t4.rgba) >>> 0;
            return [s2, r2, i] = h.toChannels(e4), { css: n.toCss(s2, r2, i), rgba: e4 };
          }, t3.opacity = e3, t3.multiplyOpacity = function(t4, s3) {
            return o = 255 & t4.rgba, e3(t4, o * s3 / 255);
          }, t3.toColorRGB = function(t4) {
            return [t4.rgba >> 24 & 255, t4.rgba >> 16 & 255, t4.rgba >> 8 & 255];
          };
        })(l || (e2.color = l = {})), (function(t3) {
          let e3, l2;
          try {
            const t4 = document.createElement("canvas");
            t4.width = 1, t4.height = 1;
            const s3 = t4.getContext("2d", { willReadFrequently: true });
            s3 && (e3 = s3, e3.globalCompositeOperation = "copy", l2 = e3.createLinearGradient(0, 0, 1, 1));
          } catch {
          }
          t3.toColor = function(t4) {
            if (t4.match(/#[\da-f]{3,8}/i)) switch (t4.length) {
              case 4:
                return s2 = parseInt(t4.slice(1, 2).repeat(2), 16), r2 = parseInt(t4.slice(2, 3).repeat(2), 16), i = parseInt(t4.slice(3, 4).repeat(2), 16), n.toColor(s2, r2, i);
              case 5:
                return s2 = parseInt(t4.slice(1, 2).repeat(2), 16), r2 = parseInt(t4.slice(2, 3).repeat(2), 16), i = parseInt(t4.slice(3, 4).repeat(2), 16), o = parseInt(t4.slice(4, 5).repeat(2), 16), n.toColor(s2, r2, i, o);
              case 7:
                return { css: t4, rgba: (parseInt(t4.slice(1), 16) << 8 | 255) >>> 0 };
              case 9:
                return { css: t4, rgba: parseInt(t4.slice(1), 16) >>> 0 };
            }
            const a2 = t4.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(,\s*(0|1|\d?\.(\d+))\s*)?\)/);
            if (a2) return s2 = parseInt(a2[1]), r2 = parseInt(a2[2]), i = parseInt(a2[3]), o = Math.round(255 * (void 0 === a2[5] ? 1 : parseFloat(a2[5]))), n.toColor(s2, r2, i, o);
            if (!e3 || !l2) throw new Error("css.toColor: Unsupported css format");
            if (e3.fillStyle = l2, e3.fillStyle = t4, "string" != typeof e3.fillStyle) throw new Error("css.toColor: Unsupported css format");
            if (e3.fillRect(0, 0, 1, 1), [s2, r2, i, o] = e3.getImageData(0, 0, 1, 1).data, 255 !== o) throw new Error("css.toColor: Unsupported css format");
            return { rgba: n.toRgba(s2, r2, i, o), css: t4 };
          };
        })(a || (e2.css = a = {})), (function(t3) {
          function e3(t4, e4, s3) {
            const r3 = t4 / 255, i2 = e4 / 255, o2 = s3 / 255;
            return 0.2126 * (r3 <= 0.03928 ? r3 / 12.92 : Math.pow((r3 + 0.055) / 1.055, 2.4)) + 0.7152 * (i2 <= 0.03928 ? i2 / 12.92 : Math.pow((i2 + 0.055) / 1.055, 2.4)) + 0.0722 * (o2 <= 0.03928 ? o2 / 12.92 : Math.pow((o2 + 0.055) / 1.055, 2.4));
          }
          t3.relativeLuminance = function(t4) {
            return e3(t4 >> 16 & 255, t4 >> 8 & 255, 255 & t4);
          }, t3.relativeLuminance2 = e3;
        })(u || (e2.rgb = u = {})), (function(t3) {
          function e3(t4, e4, s3) {
            const r3 = t4 >> 24 & 255, i2 = t4 >> 16 & 255, o2 = t4 >> 8 & 255;
            let n2 = e4 >> 24 & 255, l3 = e4 >> 16 & 255, a2 = e4 >> 8 & 255, h2 = _(u.relativeLuminance2(n2, l3, a2), u.relativeLuminance2(r3, i2, o2));
            for (; h2 < s3 && (n2 > 0 || l3 > 0 || a2 > 0); ) n2 -= Math.max(0, Math.ceil(0.1 * n2)), l3 -= Math.max(0, Math.ceil(0.1 * l3)), a2 -= Math.max(0, Math.ceil(0.1 * a2)), h2 = _(u.relativeLuminance2(n2, l3, a2), u.relativeLuminance2(r3, i2, o2));
            return (n2 << 24 | l3 << 16 | a2 << 8 | 255) >>> 0;
          }
          function l2(t4, e4, s3) {
            const r3 = t4 >> 24 & 255, i2 = t4 >> 16 & 255, o2 = t4 >> 8 & 255;
            let n2 = e4 >> 24 & 255, l3 = e4 >> 16 & 255, a2 = e4 >> 8 & 255, h2 = _(u.relativeLuminance2(n2, l3, a2), u.relativeLuminance2(r3, i2, o2));
            for (; h2 < s3 && (n2 < 255 || l3 < 255 || a2 < 255); ) n2 = Math.min(255, n2 + Math.ceil(0.1 * (255 - n2))), l3 = Math.min(255, l3 + Math.ceil(0.1 * (255 - l3))), a2 = Math.min(255, a2 + Math.ceil(0.1 * (255 - a2))), h2 = _(u.relativeLuminance2(n2, l3, a2), u.relativeLuminance2(r3, i2, o2));
            return (n2 << 24 | l3 << 16 | a2 << 8 | 255) >>> 0;
          }
          t3.blend = function(t4, e4) {
            if (o = (255 & e4) / 255, 1 === o) return e4;
            const l3 = e4 >> 24 & 255, a2 = e4 >> 16 & 255, u2 = e4 >> 8 & 255, h2 = t4 >> 24 & 255, c2 = t4 >> 16 & 255, _2 = t4 >> 8 & 255;
            return s2 = h2 + Math.round((l3 - h2) * o), r2 = c2 + Math.round((a2 - c2) * o), i = _2 + Math.round((u2 - _2) * o), n.toRgba(s2, r2, i);
          }, t3.ensureContrastRatio = function(t4, s3, r3) {
            const i2 = u.relativeLuminance(t4 >> 8), o2 = u.relativeLuminance(s3 >> 8);
            if (_(i2, o2) < r3) {
              if (o2 < i2) {
                const o3 = e3(t4, s3, r3), n3 = _(i2, u.relativeLuminance(o3 >> 8));
                if (n3 < r3) {
                  const e4 = l2(t4, s3, r3);
                  return n3 > _(i2, u.relativeLuminance(e4 >> 8)) ? o3 : e4;
                }
                return o3;
              }
              const n2 = l2(t4, s3, r3), a2 = _(i2, u.relativeLuminance(n2 >> 8));
              if (a2 < r3) {
                const o3 = e3(t4, s3, r3);
                return a2 > _(i2, u.relativeLuminance(o3 >> 8)) ? n2 : o3;
              }
              return n2;
            }
          }, t3.reduceLuminance = e3, t3.increaseLuminance = l2, t3.toChannels = function(t4) {
            return [t4 >> 24 & 255, t4 >> 16 & 255, t4 >> 8 & 255, 255 & t4];
          };
        })(h || (e2.rgba = h = {}));
      } }, e = {};
      function s(r2) {
        var i = e[r2];
        if (void 0 !== i) return i.exports;
        var o = e[r2] = { exports: {} };
        return t[r2](o, o.exports, s), o.exports;
      }
      var r = {};
      return (() => {
        var t2 = r;
        Object.defineProperty(t2, "__esModule", { value: true }), t2.HTMLSerializeHandler = t2.SerializeAddon = void 0;
        const e2 = s(992);
        function i(t3, e3, s2) {
          return Math.max(e3, Math.min(t3, s2));
        }
        class o {
          constructor(t3) {
            this._buffer = t3;
          }
          serialize(t3, e3) {
            const s2 = this._buffer.getNullCell(), r2 = this._buffer.getNullCell();
            let i2 = s2;
            const o2 = t3.start.y, n2 = t3.end.y, l2 = t3.start.x, a2 = t3.end.x;
            this._beforeSerialize(n2 - o2, o2, n2);
            for (let e4 = o2; e4 <= n2; e4++) {
              const o3 = this._buffer.getLine(e4);
              if (o3) {
                const n3 = e4 === t3.start.y ? l2 : 0, u2 = e4 === t3.end.y ? a2 : o3.length;
                for (let t4 = n3; t4 < u2; t4++) {
                  const n4 = o3.getCell(t4, i2 === s2 ? r2 : s2);
                  n4 ? (this._nextCell(n4, i2, e4, t4), i2 = n4) : console.warn(`Can't get cell at row=${e4}, col=${t4}`);
                }
              }
              this._rowEnd(e4, e4 === n2);
            }
            return this._afterSerialize(), this._serializeString(e3);
          }
          _nextCell(t3, e3, s2, r2) {
          }
          _rowEnd(t3, e3) {
          }
          _beforeSerialize(t3, e3, s2) {
          }
          _afterSerialize() {
          }
          _serializeString(t3) {
            return "";
          }
        }
        function n(t3, e3) {
          return t3.getFgColorMode() === e3.getFgColorMode() && t3.getFgColor() === e3.getFgColor();
        }
        function l(t3, e3) {
          return t3.getBgColorMode() === e3.getBgColorMode() && t3.getBgColor() === e3.getBgColor();
        }
        function a(t3, e3) {
          return t3.isInverse() === e3.isInverse() && t3.isBold() === e3.isBold() && t3.isUnderline() === e3.isUnderline() && t3.isOverline() === e3.isOverline() && t3.isBlink() === e3.isBlink() && t3.isInvisible() === e3.isInvisible() && t3.isItalic() === e3.isItalic() && t3.isDim() === e3.isDim() && t3.isStrikethrough() === e3.isStrikethrough();
        }
        class u extends o {
          constructor(t3, e3) {
            super(t3), this._terminal = e3, this._rowIndex = 0, this._allRows = new Array(), this._allRowSeparators = new Array(), this._currentRow = "", this._nullCellCount = 0, this._cursorStyle = this._buffer.getNullCell(), this._cursorStyleRow = 0, this._cursorStyleCol = 0, this._backgroundCell = this._buffer.getNullCell(), this._firstRow = 0, this._lastCursorRow = 0, this._lastCursorCol = 0, this._lastContentCursorRow = 0, this._lastContentCursorCol = 0, this._thisRowLastChar = this._buffer.getNullCell(), this._thisRowLastSecondChar = this._buffer.getNullCell(), this._nextRowFirstChar = this._buffer.getNullCell();
          }
          _beforeSerialize(t3, e3, s2) {
            this._allRows = new Array(t3), this._lastContentCursorRow = e3, this._lastCursorRow = e3, this._firstRow = e3;
          }
          _rowEnd(t3, e3) {
            this._nullCellCount > 0 && !l(this._cursorStyle, this._backgroundCell) && (this._currentRow += `\x1B[${this._nullCellCount}X`);
            let s2 = "";
            if (!e3) {
              t3 - this._firstRow >= this._terminal.rows && this._buffer.getLine(this._cursorStyleRow)?.getCell(this._cursorStyleCol, this._backgroundCell);
              const e4 = this._buffer.getLine(t3), r2 = this._buffer.getLine(t3 + 1);
              if (r2.isWrapped) {
                s2 = "";
                const i2 = e4.getCell(e4.length - 1, this._thisRowLastChar), o2 = e4.getCell(e4.length - 2, this._thisRowLastSecondChar), n2 = r2.getCell(0, this._nextRowFirstChar), a2 = n2.getWidth() > 1;
                let u2 = false;
                (n2.getChars() && a2 ? this._nullCellCount <= 1 : this._nullCellCount <= 0) && ((i2.getChars() || 0 === i2.getWidth()) && l(i2, n2) && (u2 = true), a2 && (o2.getChars() || 0 === o2.getWidth()) && l(i2, n2) && l(o2, n2) && (u2 = true)), u2 || (s2 = "-".repeat(this._nullCellCount + 1), s2 += "\x1B[1D\x1B[1X", this._nullCellCount > 0 && (s2 += "\x1B[A", s2 += `\x1B[${e4.length - this._nullCellCount}C`, s2 += `\x1B[${this._nullCellCount}X`, s2 += `\x1B[${e4.length - this._nullCellCount}D`, s2 += "\x1B[B"), this._lastContentCursorRow = t3 + 1, this._lastContentCursorCol = 0, this._lastCursorRow = t3 + 1, this._lastCursorCol = 0);
              } else s2 = "\r\n", this._lastCursorRow = t3 + 1, this._lastCursorCol = 0;
            }
            this._allRows[this._rowIndex] = this._currentRow, this._allRowSeparators[this._rowIndex++] = s2, this._currentRow = "", this._nullCellCount = 0;
          }
          _diffStyle(t3, e3) {
            const s2 = [], r2 = !n(t3, e3), i2 = !l(t3, e3), o2 = !a(t3, e3);
            if (r2 || i2 || o2) if (t3.isAttributeDefault()) e3.isAttributeDefault() || s2.push(0);
            else {
              if (r2) {
                const e4 = t3.getFgColor();
                t3.isFgRGB() ? s2.push(38, 2, e4 >>> 16 & 255, e4 >>> 8 & 255, 255 & e4) : t3.isFgPalette() ? e4 >= 16 ? s2.push(38, 5, e4) : s2.push(8 & e4 ? 90 + (7 & e4) : 30 + (7 & e4)) : s2.push(39);
              }
              if (i2) {
                const e4 = t3.getBgColor();
                t3.isBgRGB() ? s2.push(48, 2, e4 >>> 16 & 255, e4 >>> 8 & 255, 255 & e4) : t3.isBgPalette() ? e4 >= 16 ? s2.push(48, 5, e4) : s2.push(8 & e4 ? 100 + (7 & e4) : 40 + (7 & e4)) : s2.push(49);
              }
              o2 && (t3.isInverse() !== e3.isInverse() && s2.push(t3.isInverse() ? 7 : 27), t3.isBold() !== e3.isBold() && s2.push(t3.isBold() ? 1 : 22), t3.isUnderline() !== e3.isUnderline() && s2.push(t3.isUnderline() ? 4 : 24), t3.isOverline() !== e3.isOverline() && s2.push(t3.isOverline() ? 53 : 55), t3.isBlink() !== e3.isBlink() && s2.push(t3.isBlink() ? 5 : 25), t3.isInvisible() !== e3.isInvisible() && s2.push(t3.isInvisible() ? 8 : 28), t3.isItalic() !== e3.isItalic() && s2.push(t3.isItalic() ? 3 : 23), t3.isDim() !== e3.isDim() && s2.push(t3.isDim() ? 2 : 22), t3.isStrikethrough() !== e3.isStrikethrough() && s2.push(t3.isStrikethrough() ? 9 : 29));
            }
            return s2;
          }
          _nextCell(t3, e3, s2, r2) {
            if (0 === t3.getWidth()) return;
            const i2 = "" === t3.getChars(), o2 = this._diffStyle(t3, this._cursorStyle);
            if (i2 ? !l(this._cursorStyle, t3) : o2.length > 0) {
              this._nullCellCount > 0 && (l(this._cursorStyle, this._backgroundCell) || (this._currentRow += `\x1B[${this._nullCellCount}X`), this._currentRow += `\x1B[${this._nullCellCount}C`, this._nullCellCount = 0), this._lastContentCursorRow = this._lastCursorRow = s2, this._lastContentCursorCol = this._lastCursorCol = r2, this._currentRow += `\x1B[${o2.join(";")}m`;
              const t4 = this._buffer.getLine(s2);
              void 0 !== t4 && (t4.getCell(r2, this._cursorStyle), this._cursorStyleRow = s2, this._cursorStyleCol = r2);
            }
            i2 ? this._nullCellCount += t3.getWidth() : (this._nullCellCount > 0 && (l(this._cursorStyle, this._backgroundCell) || (this._currentRow += `\x1B[${this._nullCellCount}X`), this._currentRow += `\x1B[${this._nullCellCount}C`, this._nullCellCount = 0), this._currentRow += t3.getChars(), this._lastContentCursorRow = this._lastCursorRow = s2, this._lastContentCursorCol = this._lastCursorCol = r2 + t3.getWidth());
          }
          _serializeString(t3) {
            let e3 = this._allRows.length;
            this._buffer.length - this._firstRow <= this._terminal.rows && (e3 = this._lastContentCursorRow + 1 - this._firstRow, this._lastCursorCol = this._lastContentCursorCol, this._lastCursorRow = this._lastContentCursorRow);
            let s2 = "";
            for (let t4 = 0; t4 < e3; t4++) s2 += this._allRows[t4], t4 + 1 < e3 && (s2 += this._allRowSeparators[t4]);
            if (!t3) {
              const t4 = this._buffer.baseY + this._buffer.cursorY, e4 = this._buffer.cursorX, i3 = (t5) => {
                t5 > 0 ? s2 += `\x1B[${t5}C` : t5 < 0 && (s2 += `\x1B[${-t5}D`);
              };
              (t4 !== this._lastCursorRow || e4 !== this._lastCursorCol) && ((r2 = t4 - this._lastCursorRow) > 0 ? s2 += `\x1B[${r2}B` : r2 < 0 && (s2 += `\x1B[${-r2}A`), i3(e4 - this._lastCursorCol));
            }
            var r2;
            const i2 = this._terminal._core._inputHandler._curAttrData, o2 = this._diffStyle(i2, this._cursorStyle);
            return o2.length > 0 && (s2 += `\x1B[${o2.join(";")}m`), s2;
          }
        }
        t2.SerializeAddon = class {
          activate(t3) {
            this._terminal = t3;
          }
          _serializeBufferByScrollback(t3, e3, s2) {
            const r2 = e3.length, o2 = void 0 === s2 ? r2 : i(s2 + t3.rows, 0, r2);
            return this._serializeBufferByRange(t3, e3, { start: r2 - o2, end: r2 - 1 }, false);
          }
          _serializeBufferByRange(t3, e3, s2, r2) {
            return new u(e3, t3).serialize({ start: { x: 0, y: "number" == typeof s2.start ? s2.start : s2.start.line }, end: { x: t3.cols, y: "number" == typeof s2.end ? s2.end : s2.end.line } }, r2);
          }
          _serializeBufferAsHTML(t3, e3) {
            const s2 = t3.buffer.active, r2 = new h(s2, t3, e3), o2 = e3.onlySelection ?? false, n2 = e3.range;
            if (n2) return r2.serialize({ start: { x: n2.startCol, y: (n2.startLine, n2.startLine) }, end: { x: t3.cols, y: (n2.endLine, n2.endLine) } });
            if (!o2) {
              const o3 = s2.length, n3 = e3.scrollback, l3 = void 0 === n3 ? o3 : i(n3 + t3.rows, 0, o3);
              return r2.serialize({ start: { x: 0, y: o3 - l3 }, end: { x: t3.cols, y: o3 - 1 } });
            }
            const l2 = this._terminal?.getSelectionPosition();
            return void 0 !== l2 ? r2.serialize({ start: { x: l2.start.x, y: l2.start.y }, end: { x: l2.end.x, y: l2.end.y } }) : "";
          }
          _serializeModes(t3) {
            let e3 = "";
            const s2 = t3.modes;
            if (s2.applicationCursorKeysMode && (e3 += "\x1B[?1h"), s2.applicationKeypadMode && (e3 += "\x1B[?66h"), s2.bracketedPasteMode && (e3 += "\x1B[?2004h"), s2.insertMode && (e3 += "\x1B[4h"), s2.originMode && (e3 += "\x1B[?6h"), s2.reverseWraparoundMode && (e3 += "\x1B[?45h"), s2.sendFocusMode && (e3 += "\x1B[?1004h"), false === s2.wraparoundMode && (e3 += "\x1B[?7l"), "none" !== s2.mouseTrackingMode) switch (s2.mouseTrackingMode) {
              case "x10":
                e3 += "\x1B[?9h";
                break;
              case "vt200":
                e3 += "\x1B[?1000h";
                break;
              case "drag":
                e3 += "\x1B[?1002h";
                break;
              case "any":
                e3 += "\x1B[?1003h";
            }
            return e3;
          }
          serialize(t3) {
            if (!this._terminal) throw new Error("Cannot use addon until it has been loaded");
            let e3 = t3?.range ? this._serializeBufferByRange(this._terminal, this._terminal.buffer.normal, t3.range, true) : this._serializeBufferByScrollback(this._terminal, this._terminal.buffer.normal, t3?.scrollback);
            return t3?.excludeAltBuffer || "alternate" !== this._terminal.buffer.active.type || (e3 += `\x1B[?1049h\x1B[H${this._serializeBufferByScrollback(this._terminal, this._terminal.buffer.alternate, void 0)}`), t3?.excludeModes || (e3 += this._serializeModes(this._terminal)), e3;
          }
          serializeAsHTML(t3) {
            if (!this._terminal) throw new Error("Cannot use addon until it has been loaded");
            return this._serializeBufferAsHTML(this._terminal, t3 || {});
          }
          dispose() {
          }
        };
        class h extends o {
          constructor(t3, s2, r2) {
            super(t3), this._terminal = s2, this._options = r2, this._currentRow = "", this._htmlContent = "", s2._core._themeService ? this._ansiColors = s2._core._themeService.colors.ansi : this._ansiColors = e2.DEFAULT_ANSI_COLORS;
          }
          _padStart(t3, e3, s2) {
            return e3 |= 0, s2 = s2 ?? " ", t3.length > e3 ? t3 : ((e3 -= t3.length) > s2.length && (s2 += s2.repeat(e3 / s2.length)), s2.slice(0, e3) + t3);
          }
          _beforeSerialize(t3, e3, s2) {
            this._htmlContent += "<html><body><!--StartFragment--><pre>";
            let r2 = "#000000", i2 = "#ffffff";
            this._options.includeGlobalBackground && (r2 = this._terminal.options.theme?.foreground ?? "#ffffff", i2 = this._terminal.options.theme?.background ?? "#000000");
            const o2 = [];
            o2.push("color: " + r2 + ";"), o2.push("background-color: " + i2 + ";"), o2.push("font-family: " + this._terminal.options.fontFamily + ";"), o2.push("font-size: " + this._terminal.options.fontSize + "px;"), this._htmlContent += "<div style='" + o2.join(" ") + "'>";
          }
          _afterSerialize() {
            this._htmlContent += "</div>", this._htmlContent += "</pre><!--EndFragment--></body></html>";
          }
          _rowEnd(t3, e3) {
            this._htmlContent += "<div><span>" + this._currentRow + "</span></div>", this._currentRow = "";
          }
          _getHexColor(t3, e3) {
            const s2 = e3 ? t3.getFgColor() : t3.getBgColor();
            return (e3 ? t3.isFgRGB() : t3.isBgRGB()) ? "#" + [s2 >> 16 & 255, s2 >> 8 & 255, 255 & s2].map(((t4) => this._padStart(t4.toString(16), 2, "0"))).join("") : (e3 ? t3.isFgPalette() : t3.isBgPalette()) ? this._ansiColors[s2].css : void 0;
          }
          _diffStyle(t3, e3) {
            const s2 = [], r2 = !n(t3, e3), i2 = !l(t3, e3), o2 = !a(t3, e3);
            if (r2 || i2 || o2) {
              const e4 = this._getHexColor(t3, true);
              e4 && s2.push("color: " + e4 + ";");
              const r3 = this._getHexColor(t3, false);
              return r3 && s2.push("background-color: " + r3 + ";"), t3.isInverse() && s2.push("color: #000000; background-color: #BFBFBF;"), t3.isBold() && s2.push("font-weight: bold;"), t3.isUnderline() && t3.isOverline() ? s2.push("text-decoration: overline underline;") : t3.isUnderline() ? s2.push("text-decoration: underline;") : t3.isOverline() && s2.push("text-decoration: overline;"), t3.isBlink() && s2.push("text-decoration: blink;"), t3.isInvisible() && s2.push("visibility: hidden;"), t3.isItalic() && s2.push("font-style: italic;"), t3.isDim() && s2.push("opacity: 0.5;"), t3.isStrikethrough() && s2.push("text-decoration: line-through;"), s2;
            }
          }
          _nextCell(t3, e3, s2, r2) {
            if (0 === t3.getWidth()) return;
            const i2 = "" === t3.getChars(), o2 = this._diffStyle(t3, e3);
            o2 && (this._currentRow += 0 === o2.length ? "</span><span>" : "</span><span style='" + o2.join(" ") + "'>"), this._currentRow += i2 ? " " : (function(t4) {
              switch (t4) {
                case "&":
                  return "&amp;";
                case "<":
                  return "&lt;";
              }
              return t4;
            })(t3.getChars());
          }
          _serializeString() {
            return this._htmlContent;
          }
        }
        t2.HTMLSerializeHandler = h;
      })(), r;
    })()));
  }
});
var __mod = require_addon_serialize();
export const SerializeAddon = __mod.SerializeAddon;
export default __mod;
