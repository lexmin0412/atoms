import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { Streamdown } from 'streamdown';

import 'streamdown/styles.css';

/**
 * 面向流式的 Markdown 渲染（Streamdown）。
 * `animating` 为 true 时表示内容仍在流式输出中，Streamdown 会按未闭合 Markdown 处理。
 */
export default function Markdown({
  text,
  animating,
}: {
  text: string;
  animating?: boolean;
}) {
  return (
    <Streamdown
      className="text-sm leading-relaxed"
      plugins={{ code, cjk }}
      isAnimating={animating}
      animated
    >
      {text}
    </Streamdown>
  );
}
