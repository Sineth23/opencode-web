import { createSignal, createEffect, onCleanup } from 'solid-js';
import { marked } from 'marked';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';

interface MarkdownProps {
  content: string;
}

const MARKDOWN_DEBOUNCE = 50;

(marked as any).setOptions({
  highlight: (code: string, lang?: string) => {
    if (code.length > 3000) return code;
    if (lang && (Prism as any).languages[lang]) {
      try {
        return Prism.highlight(code, (Prism as any).languages[lang], lang);
      } catch (e) {
        console.error('Prism highlight error:', e);
      }
    }
    return code;
  },
  breaks: true,
} as any);

export default function Markdown(props: MarkdownProps) {
  const [html, setHtml] = createSignal('');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let idleCallbackId: number | null = null;

  createEffect(() => {
    const content = props.content;

    if (debounceTimer) clearTimeout(debounceTimer);
    if (idleCallbackId !== null) cancelIdleCallback(idleCallbackId);

    debounceTimer = setTimeout(() => {
      debounceTimer = null;

      // Schedule parsing during browser idle time
      if ('requestIdleCallback' in window) {
        idleCallbackId = requestIdleCallback(
          () => {
            try {
              const parsed = (marked as any).parse(content) as string;
              setHtml(parsed);
            } catch (e) {
              console.error('Markdown parse error:', e);
              setHtml('');
            }
          },
          { timeout: 1000 }
        );
      } else {
        // Fallback for browsers without requestIdleCallback
        setTimeout(() => {
          try {
            const parsed = (marked as any).parse(content) as string;
            setHtml(parsed);
          } catch (e) {
            console.error('Markdown parse error:', e);
            setHtml('');
          }
        }, 0);
      }
    }, MARKDOWN_DEBOUNCE);
  });

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (idleCallbackId !== null) cancelIdleCallback(idleCallbackId);
  });

  return <div innerHTML={html()} class="markdown-content" />;
}
