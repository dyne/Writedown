import type { LogEntry } from 'texlyre-busytex';
import type { Diagnostic } from './contracts.ts';
import { sourceLine } from './paths.ts';
import type { CompilerPathMap } from './paths.ts';

const texTools = new Set(['pdflatex', 'xelatex', 'luahblatex', 'lualatex']);

function readTeXDiagnostics(text: string, paths: CompilerPathMap): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // null marks a file outside the snapshot, undefined a plain parenthesis.
  const openFiles: (string | null | undefined)[] = [];
  const activeFile = () => openFiles.findLast(path => path !== undefined) ?? undefined;
  let pendingError: { index: number; path: string | undefined } | undefined;

  for (const line of text.split(/\r?\n/)) {
    const error = line.match(/^!\s+(\S.*)/)?.[1];
    if (error) {
      if (error.startsWith('==>') || (pendingError && error === 'Emergency stop.')) continue;
      pendingError = { index: diagnostics.length, path: activeFile() };
      diagnostics.push({ severity: 'error', message: error });
      continue;
    }
    const errorLine = line.match(/^l\.(\d+)\b/)?.[1];
    if (errorLine && pendingError) {
      const { index, path } = pendingError;
      const mappedLine = path ? sourceLine(paths, path, Number(errorLine)) : undefined;
      if (mappedLine !== undefined) diagnostics[index] = { ...diagnostics[index], path, line: mappedLine };
      pendingError = undefined;
      continue;
    }
    const warning = line.match(/^(?:LaTeX(?: Font)?|Package \S+|Class \S+) Warning:\s*(.+)/)?.[1];
    if (warning) {
      const lineNumber = warning.match(/\bon input line (\d+)\b/)?.[1];
      const path = activeFile();
      const mappedLine = path && lineNumber ? sourceLine(paths, path, Number(lineNumber)) : undefined;
      diagnostics.push(mappedLine !== undefined
        ? { severity: 'warning', message: warning, path, line: mappedLine }
        : { severity: 'warning', message: warning });
      continue;
    }
    if (pendingError) continue;

    // TeX traces files with parentheses. Keep unresolved file frames so a
    // package error cannot accidentally point at the calling editor file.
    for (const token of line.matchAll(/\((?:"([^"]+)"|([^\s()]+))?|\)/g)) {
      if (token[0] === ')') {
        openFiles.pop();
        continue;
      }
      const path = token[1] ?? token[2] ?? '';
      const mapped = paths.resolve(path);
      openFiles.push(mapped ?? (/^(?:\/|\.\.?\/)/.test(path) ? null : undefined));
    }
  }
  return diagnostics;
}

function readToolDiagnostics(text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    const tagged = line.trim().match(/^(?:[\w-]+:\s*)?(warning|warn|error|fatal)\s*(?::|--?)\s*(.+)/i);
    if (tagged) {
      const severity = /^warn/i.test(tagged[1]) ? 'warning' : 'error';
      diagnostics.push({ severity, message: tagged[2] });
    } else if (/^I couldn't open (?:database|style) file\b/.test(line)) {
      diagnostics.push({ severity: 'error', message: line });
    }
  }
  return diagnostics;
}

export function readCompilationDiagnostics(logs: readonly LogEntry[], paths: CompilerPathMap): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lastTeX = logs.findLastIndex(entry => texTools.has(entry.cmd.split(' ')[0]));
  for (const [index, entry] of logs.entries()) {
    const tool = entry.cmd.split(' ')[0];
    // Initial citation and reference warnings are expected. The final TeX
    // log retains any that survived the driver's rerun sequence.
    if (texTools.has(tool)) {
      if (index === lastTeX) diagnostics.push(...readTeXDiagnostics(entry.log || entry.stdout, paths));
      continue;
    }
    const found = readToolDiagnostics([entry.log, entry.stderr, entry.stdout].join('\n'));
    if (entry.exit_code !== 0 && found.every(item => item.severity !== 'error')) {
      found.push({ severity: 'error', message: tool + ' exited with status ' + entry.exit_code + '.' });
    }
    diagnostics.push(...found);
  }
  const seen = new Set<string>();
  return diagnostics.filter(diagnostic => {
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
