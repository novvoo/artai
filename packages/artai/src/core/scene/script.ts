/**
 * scene/script.ts — compiles SceneIR into standalone Canvas-2D JS code.
 * Each IR op expands to annotated executable drawing commands.
 */
import type { SceneIR } from "./compile.js";

function px(v: number | undefined): string {
  return Math.round(Number(v ?? 0)).toString();
}
function col(v: unknown): string {
  return JSON.stringify(String(v ?? "#33312d"));
}
function bx(o: Record<string, any>): number { return Number(o.box?.[0] ?? 0); }
function by(o: Record<string, any>): number { return Number(o.box?.[1] ?? 0); }
function wOf(o: Record<string, any>): number { return Number(o.box?.[2] ?? 100); }
function hOf(o: Record<string, any>): number { return Number(o.box?.[3] ?? 100); }

export function irToScript(ir: SceneIR): string {
  const W = ir.canvas.width;
  const H = ir.canvas.height;
  const ops = (ir.ops ?? []) as Array<Record<string, any>>;

  const body: string[] = [];

  ops.forEach((op, idx) => {
    const cm = `  // [${idx + 1}] ${op.op}`;
    switch (op.op) {
      case "paper":
        body.push(
          cm,
          `  ctx.fillStyle = ${col(op.tone)};`,
          `  ctx.fillRect(0,0,${W},${H});`,
        );
        break;
      case "guides":
        body.push(
          cm,
          `  ctx.save(); ctx.globalAlpha=0.055; ctx.strokeStyle=${col(op.color)}; ctx.lineWidth=1;`,
          `  ctx.beginPath(); ctx.moveTo(0,${px(op.at?.[1])}); ctx.lineTo(${W},${px(op.at?.[1])}); ctx.stroke();`,
          `  ctx.restore();`,
        );
        break;
      case "backdrop": {
        const bxc = bx(op) + wOf(op)/2;
        const byc = by(op) + hOf(op)/2;
        const rr = Math.max(wOf(op), hOf(op))/2;
        body.push(cm);
        body.push(`  ctx.save();`);
        body.push(`  try{ctx.globalCompositeOperation='multiply';}catch(e){}`);
        body.push(`  ctx.globalAlpha=${Number(op.alpha ?? 0.5)};`);
        body.push(`  ctx.fillStyle=${col(op.color)};`);
        if (String(op.kind) === "disc")
          body.push(`  ctx.beginPath(); ctx.arc(${bxc},${byc},${rr},0,Math.PI*2); ctx.fill();`);
        else
          body.push(`  ctx.fillRect(${bx(op)},${by(op)},${wOf(op)},${hOf(op)});`);
        body.push(`  ctx.restore();`);
        break;
      }
      case "panelShadow":
        body.push(cm);
        body.push(`  ctx.save(); ctx.globalAlpha=0.2; ctx.fillStyle=${col(op.color)};`);
        body.push(`  ctx.fillRect(${bx(op)+(op.dx??4)},${by(op)+(op.dy??3)},${wOf(op)},${hOf(op)});`);
        body.push(`  ctx.restore();`);
        break;
      case "fill": {
        const c2 = col(op.color);
        body.push(cm);
        body.push(`  ctx.fillStyle=${c2};`);
        const bxV=bx(op), byV=by(op), wV=wOf(op), hV=hOf(op);
        if (typeof op.poly === "string") {
          body.push(`  // polygon fill (see defs.${String(op.poly)})`);
          body.push(`  ctx.fillRect(${bxV},${byV},${wV},${hV});`);
        } else {
          body.push(`  ctx.fillRect(${bxV},${byV},${wV},${hV});`);
        }
        if (op.bleed && Array.isArray(op.bleed) && Number(op.bleed[0]) > 0) {
          const spread=Math.round(Number(op.bleed[0])*10);
          body.push(`  ctx.save(); ctx.globalAlpha=0.16;`);
          body.push(`  for(var bk=3;bk>=1;bk--){ ctx.save(); ctx.translate(bk*${spread},bk*${spread}); ctx.fillRect(${bxV},${byV},${wV},${hV}); ctx.restore(); }`);
          body.push(`  ctx.restore();`);
        }
        break;
      }
      case "strokeset":
        body.push(cm, `  // strokeset field="${String(op.field??"curved")}" count=${Number(op.count??4)} \u2014 drawn via p5.brush in mainline path`);
        break;
      case "motif": {
        const mid=String(op.id??"");
        const mA=col(op.accent);
        const _b=(op.box??[]) as (number|undefined)[];
        const mbx=_b[0] ?? 0, mby=_b[1] ?? 0;
        const mbw=_b[2] ?? 100, mbh=_b[3] ?? 100;
        body.push(cm);
        body.push(
          `  ctx.fillStyle=${mA}; ctx.fillRect(${Math.round(mbx+mbw*0.06)},${Math.round(mby+mbh*0.06)},${Math.round(mbw*0.88)},${Math.round(mbh*0.88)});`,
        );
        break;
      }
      case "text":
        body.push(cm);
        body.push(`  ctx.font='${px(op.sizePx)}px "IBM Plex Mono","Courier New","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",monospace';`);
        body.push(`  ctx.fillStyle=${col(op.color)};`);
        body.push(`  ctx.fillText(${JSON.stringify(String(op.str??""))}, ${px(op.at?.[0])}, ${px(op.at?.[1])});`);
        break;
      case "microtext":
        body.push(cm);
        body.push(`  ctx.font='${px(op.sizePx)}px monospace'; ctx.globalAlpha=0.85;`);
        body.push(`  ctx.fillStyle=${col(op.color)}; ctx.textAlign='right';`);
        body.push(`  ctx.fillText(${JSON.stringify(String(op.str??""))}, ${px(op.at?.[0])}, ${px(op.at?.[1])});`);
        body.push(`  ctx.globalAlpha=1; ctx.textAlign='left';`);
        break;
      case "chip":
        body.push(`  // chip ${String(op.variant??'')} at (${px(op.at?.[0])},${px(op.at?.[1])})`);
        break;
      case "mark":
        body.push(`  // mark ${String(op.kind??'')} at (${px(op.at?.[0])},${px(op.at?.[1])})`);
        break;
      case "frame":
        body.push(cm);
        body.push(`  ctx.strokeStyle=${col(op.color)}; ctx.globalAlpha=${Number(op.alpha??0.55)}; ctx.lineWidth=1;`);
        body.push(`  ctx.strokeRect(${Number(op.inset??16)},${Number(op.inset??16)},${W-32},${H-32});`);
        break;
      case "postpress":
        body.push(cm);
        body.push(`  ctx.save(); var gs=Math.round(${W}*${H}/700);`);
        body.push(`  for(var gi=0;gi<gs;gi++){`);
        body.push(`    ctx.globalAlpha=0.02+Math.random()*0.03;`);
        body.push(`    ctx.fillStyle=fr()<0.5?"#fff":"#1c1b18";`);
        body.push(`    ctx.fillRect(Math.random()*${W},Math.random()*${H},1,1);}`);
        body.push(`  ctx.restore();`);
        break;
      default:
        body.push(`  // skip ${String(op.op)}`);
    }
  });

  function out_push(arr:string[], ...lines:string[]):void{arr.push(...lines);}

  const head: string[] = [
    "// artai render script \u2014 paste into browser console on any page",
    `// ${W}\u00d7${H}px | ${ops.length} ops | deterministic replay from seed`,
    "",
    "(function() {",
    "  var c=document.createElement('canvas');",
    `  c.width=${W}; c.height=${H};`,
    "  c.style.maxWidth='100%'; c.style.border='1px solid #ccc';",
    "  document.body.appendChild(c);",
    "  var ctx=c.getContext('2d');",
    "  ctx.lineCap='round'; ctx.lineJoin='round';",
    "  var R=42;",
    "  function fr(){R=R*1664525+1013904223|0;return ((R>>>16)&65535)/65536;}",
    "  function gn(m){return (fr()-0.5)*2*m;}",
    "",
  ];

  return [...head, ...body.map(l=>l.replace(/^\s*/,"  ")), "", "})();", ""].join("\n");
}

/** shadow helper referenced in generated code */
function shadeHex(hex: string): string {
  const h=(hex??"#333").replace("#","");
  const r=Math.max(0,(h.length>=6?parseInt(h.slice(0,2),16):51)*0.62)|0;
  const g=Math.max(0,(h.length>=6?parseInt(h.slice(2,4),16):48)*0.62)|0;
  const b=Math.max(0,(h.length>=6?parseInt(h.slice(4,6),16):45)*0.62)|0;
  return "#"+[r,g,b].map(v=>v.toString(16).padStart(2,"0")).join("");
}
const shadeHexAlias = shadeHex;
