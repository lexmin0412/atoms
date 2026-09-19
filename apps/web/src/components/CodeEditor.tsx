import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';

function extensionsFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return [javascript({ typescript: true, jsx: ext === 'tsx' })];
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return [javascript({ jsx: ext === 'jsx' })];
    case 'json':
      return [json()];
    case 'css':
    case 'scss':
    case 'less':
      return [css()];
    case 'html':
    case 'htm':
    case 'vue':
      return [html()];
    case 'md':
    case 'markdown':
      return [markdown()];
    default:
      return [];
  }
}

interface Props {
  path: string;
  value: string;
  readOnly: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
}

export default function CodeEditor({ path, value, readOnly, onChange, onSave }: Props) {
  const extensions = useMemo(
    () => [
      ...extensionsFor(path),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSave();
            return true;
          },
        },
      ]),
      EditorView.lineWrapping,
    ],
    [path, onSave],
  );

  return (
    <CodeMirror
      value={value}
      height="100%"
      className="min-h-0 flex-1 overflow-auto text-xs"
      theme={oneDark}
      readOnly={readOnly}
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: true,
        autocompletion: true,
      }}
      onChange={onChange}
    />
  );
}
