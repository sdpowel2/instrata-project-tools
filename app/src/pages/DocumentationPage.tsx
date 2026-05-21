import { useEffect, useRef } from 'react';
import { useDocNav } from '../store/docNavStore';

export function DocumentationPage() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const setCrumbs = useDocNav((s) => s.setCrumbs);
  const setNavigate = useDocNav((s) => s.setNavigate);

  useEffect(() => {
    // Register the iframe navigate fn so the sidebar crumbs can drive it
    setNavigate((href: string) => {
      const iframe = iframeRef.current;
      if (iframe?.contentWindow) {
        iframe.contentWindow.location.hash = href.replace(/^#/, '');
      }
    });

    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'avss-crumbs' && Array.isArray(e.data.parts)) {
        setCrumbs(e.data.parts);
      }
    };
    window.addEventListener('message', handler);

    return () => {
      window.removeEventListener('message', handler);
      setCrumbs([]);
      setNavigate(null);
    };
  }, [setCrumbs, setNavigate]);

  return (
    <div className="h-full w-full">
      <iframe
        ref={iframeRef}
        src="/process-doc.html?embedded=1"
        title="AVSS Process Documentation"
        className="w-full h-full border-0"
        style={{ minHeight: '100vh' }}
      />
    </div>
  );
}
