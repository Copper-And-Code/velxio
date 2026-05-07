import React from 'react';

interface CodeBlockProps {
  children: string;
  language?: string;
}

const codeStyle: React.CSSProperties = {
  margin: '16px 0',
  borderRadius: '8px',
  padding: '16px',
  overflowX: 'auto',
  background: '#1e1e1e',
  color: '#d4d4d4',
  fontSize: '13px',
  fontFamily: 'var(--mono, monospace)',
  lineHeight: 1.55,
};

export const CodeBlock: React.FC<CodeBlockProps> = ({ children, language = 'text' }) => (
  <pre style={codeStyle}>
    <code className={`language-${language}`}>{children.trim()}</code>
  </pre>
);
