import { memo, useMemo } from "react";

/**
 * 把指纹拆成冒号分隔的段。非标准格式(无冒号)按每 2 字符切,
 * 这样 SHA256 裸 hex 也能逐段比对。
 */
function segments(fp: string): string[] {
  const body = fp.replace(/^[A-Za-z0-9-]+:\s*/, "");
  if (body.includes(":")) return body.split(":");
  return body.match(/.{1,2}/g) ?? [body];
}

/** 前缀(如 "SHA-256: "),保留原样显示但压低对比度。 */
function prefix(fp: string): string {
  const m = fp.match(/^([A-Za-z0-9-]+:\s*)/);
  return m ? m[1] : "";
}

/**
 * FingerprintDiff — 证书指纹逐段对比。
 *
 * 为什么要做到这个粒度:pinMismatch 有两种成因 —— 桌面端重装了 pi(良性),
 * 或有人在中间冒充设备(恶性)。二者在 UI 上无法自动区分,只有用户能判断。
 * 所以必须把两个指纹并排摆出来、把差异段标出来,让用户自己看。只给一句
 * 「证书不匹配」加一个「信任」按钮,等于把安全决策变成盲选。
 *
 * 差异段同时用颜色 + 下划线标注,不单靠颜色(色盲可达)。
 */
export const FingerprintDiff = memo(function FingerprintDiff({
  expected,
  actual,
  expectedLabel,
  actualLabel,
}: {
  expected: string;
  actual: string;
  expectedLabel: string;
  actualLabel: string;
}) {
  const { expSegs, actSegs, diffAt } = useMemo(() => {
    const a = segments(expected);
    const b = segments(actual);
    const diff = new Set<number>();
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) diff.add(i);
    }
    return { expSegs: a, actSegs: b, diffAt: diff };
  }, [expected, actual]);

  return (
    <div className="fp">
      <div className="fpg">
        <span className="fpl">{expectedLabel}</span>
        <span className="fpv">
          <span className="pfx">{prefix(expected)}</span>
          {expSegs.join(":")}
        </span>
      </div>

      <div className="fpsep" aria-hidden="true" />

      <div className="fpg bad">
        <span className="fpl">{actualLabel}</span>
        <span className="fpv">
          <span className="pfx">{prefix(actual)}</span>
          {actSegs.map((seg, i) => (
            <span key={i}>
              {i > 0 && ":"}
              {diffAt.has(i) ? <mark>{seg}</mark> : seg}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
});
