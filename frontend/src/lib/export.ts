import type { Persona, Session, Analysis } from './types';

export type ExportFormat = 'pdf' | 'docx' | 'csv' | 'md';

type DimensionKey =
  | 'relevance'
  | 'technical_credibility'
  | 'differentiation'
  | 'actionability'
  | 'trust_signals'
  | 'language_fit';

export type DimensionScore = {
  score: number;
  commentary: string;
};

export type ExportAnalysis = {
  persona_id: string;
  persona_name: string;
  persona_role: string;
  status: Analysis['status'];
  analysis_provider: string;
  analysis_model: string;
  error_message?: string;
  dimension_scores: Partial<Record<DimensionKey, DimensionScore>>;
  top_issues: Array<{
    issue: string;
    specific_example_from_content: string;
    suggested_rewrite: string;
  }>;
  what_works_well: string[];
  overall_verdict: string;
  rewritten_headline: string;
};

export type ExportTheme = {
  label: string;
  count: number;
  personas: string[];
};

export type ExportModel = {
  exported_at: string;
  session: {
    id: string;
    file_name: string;
    created_at: string;
    status: Session['status'];
    analysis_provider: string;
    analysis_model: string;
  };
  analysis_backend: {
    provider: string;
    model: string;
  };
  stats: {
    personas_total: number;
    completed: number;
    failed: number;
    pending_or_running: number;
  };
  dimension_averages: Record<DimensionKey, number | null>;
  common_themes: ExportTheme[];
  common_strengths: ExportTheme[];
  recommendations: string[];
  analyses: ExportAnalysis[];
};

const DIMENSIONS: DimensionKey[] = [
  'relevance',
  'technical_credibility',
  'differentiation',
  'actionability',
  'trust_signals',
  'language_fit',
];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'over', 'under',
  'your', 'you', 'our', 'their', 'they', 'them', 'its', 'it', 'are', 'is', 'was', 'were',
  'be', 'been', 'being', 'as', 'at', 'by', 'of', 'on', 'in', 'to', 'a', 'an', 'or', 'but',
  'not', 'no', 'yes', 'we', 'i', 'me', 'my', 'mine', 'us', 'can', 'could', 'should', 'would',
  'will', 'just', 'very', 'more', 'most', 'less', 'least', 'than', 'then', 'so', 'if', 'when',
  'what', 'why', 'how', 'who', 'which', 'also', 'too', 'any', 'all', 'some',
]);

function safeJsonParse<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as T;
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s: string): string[] {
  const tokens = normalizeText(s).split(' ');
  return tokens
    .map(t => t.trim())
    .filter(t => t.length >= 3)
    .filter(t => !STOPWORDS.has(t))
    .slice(0, 16);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function clusterThemes(items: Array<{ text: string; persona: string }>, threshold = 0.45): ExportTheme[] {
  type Cluster = { label: string; tokens: Set<string>; personas: Set<string>; count: number };
  const clusters: Cluster[] = [];

  for (const item of items) {
    const text = item.text?.trim();
    if (!text) continue;
    const tokens = new Set(tokenize(text));
    if (tokens.size === 0) continue;

    let assigned = false;
    for (const c of clusters) {
      if (jaccard(tokens, c.tokens) >= threshold) {
        c.count++;
        c.personas.add(item.persona);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      clusters.push({
        label: text,
        tokens,
        personas: new Set([item.persona]),
        count: 1,
      });
    }
  }

  return clusters
    .map(c => ({
      label: c.label,
      count: c.count,
      personas: Array.from(c.personas).sort((x, y) => x.localeCompare(y)),
    }))
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));
}

function dimLabel(dim: DimensionKey): string {
  return dim.replace(/_/g, ' ');
}

function scoreAvg(values: number[]): number | null {
  const filtered = values.filter(v => Number.isFinite(v));
  if (filtered.length === 0) return null;
  return Math.round((filtered.reduce((a, b) => a + b, 0) / filtered.length) * 10) / 10;
}

function recommendationsForLowestDimensions(lowest: DimensionKey[]): string[] {
  const map: Record<DimensionKey, string> = {
    relevance: 'Tighten relevance: lead with the exact pain points and priorities of the target buyer, and align every claim to them.',
    technical_credibility: 'Increase technical credibility: replace vague claims with concrete details (architecture, controls, limits, integrations, evidence).',
    differentiation: 'Clarify differentiation: state what is meaningfully different versus alternatives, using specific, defensible differentiators.',
    actionability: 'Improve actionability: add clear next steps, an implementation path, and explicit calls to action.',
    trust_signals: 'Add trust signals: include measurable outcomes, customer proof, third-party validation, and security/compliance credentials.',
    language_fit: 'Match the audience language: reduce marketing fluff and use practitioner terminology with precise wording.',
  };

  const unique = Array.from(new Set(lowest));
  return unique.map(d => map[d]);
}

function parseDimensionScores(scoreJson: unknown): Partial<Record<DimensionKey, DimensionScore>> {
  const parsed = safeJsonParse<any>(scoreJson);
  if (!parsed || typeof parsed !== 'object') return {};

  const out: Partial<Record<DimensionKey, DimensionScore>> = {};
  for (const dim of DIMENSIONS) {
    const v = parsed[dim];
    if (v && typeof v === 'object') {
      const score = Number(v.score);
      const commentary = typeof v.commentary === 'string' ? v.commentary : '';
      out[dim] = {
        score: Number.isFinite(score) ? score : 0,
        commentary,
      };
    }
  }
  return out;
}

function parseTopIssues(topIssuesJson: unknown): ExportAnalysis['top_issues'] {
  const parsed = safeJsonParse<any>(topIssuesJson);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((x) => ({
      issue: typeof x?.issue === 'string' ? x.issue : '',
      specific_example_from_content: typeof x?.specific_example_from_content === 'string' ? x.specific_example_from_content : '',
      suggested_rewrite: typeof x?.suggested_rewrite === 'string' ? x.suggested_rewrite : '',
    }))
    .filter(x => x.issue || x.suggested_rewrite || x.specific_example_from_content);
}

function parseSuggestions(suggestionsJson: unknown): {
  what_works_well: string[];
  overall_verdict: string;
  rewritten_headline: string;
} {
  const parsed = safeJsonParse<any>(suggestionsJson);
  if (!parsed || typeof parsed !== 'object') {
    return { what_works_well: [], overall_verdict: '', rewritten_headline: '' };
  }

  const www = Array.isArray(parsed.what_works_well)
    ? parsed.what_works_well.filter((x: any) => typeof x === 'string').map((x: string) => x.trim()).filter(Boolean)
    : [];

  return {
    what_works_well: www,
    overall_verdict: typeof parsed.overall_verdict === 'string' ? parsed.overall_verdict : '',
    rewritten_headline: typeof parsed.rewritten_headline === 'string' ? parsed.rewritten_headline : '',
  };
}

export function buildExportModel(session: Session, personasById: Record<string, Persona>): ExportModel {
  const exportedAt = new Date().toISOString();

  const sessionProvider = (session.analysis_provider || '').trim();
  const sessionModel = (session.analysis_model || '').trim();

  const analyses: ExportAnalysis[] = (session.analyses || []).map((a) => {
    const persona = personasById[a.persona_id];
    const personaName = persona?.name || a.persona_name || 'Unknown Persona';
    const personaRole = persona?.role || '';

    const analysisProvider = (a.analysis_provider || sessionProvider || '').trim();
    const analysisModel = (a.analysis_model || sessionModel || '').trim();

    const dimensionScores = parseDimensionScores(a.score_json);
    const topIssues = parseTopIssues(a.top_issues_json);
    const suggestions = parseSuggestions(a.rewritten_suggestions_json);

    return {
      persona_id: a.persona_id,
      persona_name: personaName,
      persona_role: personaRole,
      status: a.status,
      analysis_provider: analysisProvider,
      analysis_model: analysisModel,
      error_message: a.error_message,
      dimension_scores: dimensionScores,
      top_issues: topIssues,
      what_works_well: suggestions.what_works_well,
      overall_verdict: suggestions.overall_verdict,
      rewritten_headline: suggestions.rewritten_headline,
    };
  }).sort((x, y) => x.persona_name.localeCompare(y.persona_name));

  const completed = analyses.filter(a => a.status === 'completed');
  const failed = analyses.filter(a => a.status === 'failed');
  const pendingOrRunning = analyses.filter(a => a.status !== 'completed' && a.status !== 'failed');

  const inferredProvider = sessionProvider || completed[0]?.analysis_provider || 'unknown';
  const inferredModel = sessionModel || completed[0]?.analysis_model || 'unknown';

  const dimAverages: Record<DimensionKey, number | null> = {
    relevance: null,
    technical_credibility: null,
    differentiation: null,
    actionability: null,
    trust_signals: null,
    language_fit: null,
  };

  for (const dim of DIMENSIONS) {
    const values: number[] = [];
    for (const a of completed) {
      const s = a.dimension_scores[dim]?.score;
      if (typeof s === 'number') values.push(s);
    }
    dimAverages[dim] = scoreAvg(values);
  }

  const issuesItems: Array<{ text: string; persona: string }> = [];
  const strengthItems: Array<{ text: string; persona: string }> = [];

  for (const a of completed) {
    for (const issue of a.top_issues) {
      if (issue.issue) issuesItems.push({ text: issue.issue, persona: a.persona_name });
    }
    for (const s of a.what_works_well) {
      if (s) strengthItems.push({ text: s, persona: a.persona_name });
    }
  }

  const themeClusters = clusterThemes(issuesItems);
  const strengthClusters = clusterThemes(strengthItems, 0.4);

  const commonThemes = themeClusters.filter(t => t.count >= 2).slice(0, 6);
  const commonStrengths = strengthClusters.filter(t => t.count >= 2).slice(0, 6);

  const lowestDims = [...DIMENSIONS]
    .map((dim) => ({ dim, avg: dimAverages[dim] }))
    .filter((x) => typeof x.avg === 'number')
    .sort((a, b) => (a.avg as number) - (b.avg as number))
    .slice(0, 3)
    .map(x => x.dim);

  const recommendations = recommendationsForLowestDimensions(lowestDims);

  return {
    exported_at: exportedAt,
    session: {
      id: session.id,
      file_name: session.file_name,
      created_at: session.created_at,
      status: session.status,
      analysis_provider: inferredProvider,
      analysis_model: inferredModel,
    },
    analysis_backend: {
      provider: inferredProvider,
      model: inferredModel,
    },
    stats: {
      personas_total: analyses.length,
      completed: completed.length,
      failed: failed.length,
      pending_or_running: pendingOrRunning.length,
    },
    dimension_averages: dimAverages,
    common_themes: commonThemes.length > 0 ? commonThemes : themeClusters.slice(0, 6),
    common_strengths: commonStrengths.length > 0 ? commonStrengths : strengthClusters.slice(0, 6),
    recommendations,
    analyses,
  };
}

export function exportToMarkdown(model: ExportModel): string {
  const lines: string[] = [];

  lines.push(`# Roundtable Export`);
  lines.push('');
  lines.push(`- Document: **${model.session.file_name}**`);
  lines.push(`- Session: \`${model.session.id}\``);
  lines.push(`- Session status: **${model.session.status}**`);
  lines.push(`- Analysis backend: **${model.analysis_backend.provider} / ${model.analysis_backend.model}**`);
  lines.push(`- Exported at: \`${model.exported_at}\``);
  lines.push('');

  lines.push(`## Executive Summary`);
  lines.push('');
  lines.push(`### Overview`);
  lines.push(`- Personas: ${model.stats.personas_total} (completed: ${model.stats.completed}, failed: ${model.stats.failed}, in progress: ${model.stats.pending_or_running})`);
  lines.push('');

  lines.push(`### Score Snapshot (Avg Across Completed Personas)`);
  for (const dim of DIMENSIONS) {
    const v = model.dimension_averages[dim];
    const s = typeof v === 'number' ? `${v.toFixed(1)}/10` : 'N/A';
    lines.push(`- ${dimLabel(dim)}: ${s}`);
  }
  lines.push('');

  if (model.common_themes.length > 0) {
    lines.push(`### Common Themes`);
    for (const t of model.common_themes) {
      const who = t.personas.length > 0 ? ` (${t.personas.join(', ')})` : '';
      lines.push(`- (${t.count} personas) ${t.label}${who}`);
    }
    lines.push('');
  }

  if (model.common_strengths.length > 0) {
    lines.push(`### Highlights`);
    for (const t of model.common_strengths) {
      const who = t.personas.length > 0 ? ` (${t.personas.join(', ')})` : '';
      lines.push(`- (${t.count} personas) ${t.label}${who}`);
    }
    lines.push('');
  }

  if (model.recommendations.length > 0) {
    lines.push(`### Recommendations`);
    for (const r of model.recommendations) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  lines.push(`## Persona Details`);
  lines.push('');

  for (const a of model.analyses) {
    lines.push(`### ${a.persona_name}${a.persona_role ? ` (${a.persona_role})` : ''}`);
    lines.push('');
    lines.push(`- Status: **${a.status}**`);
    {
      const provider = (a.analysis_provider || model.analysis_backend.provider || '').trim();
      const backendModel = (a.analysis_model || model.analysis_backend.model || '').trim();
      if (provider && backendModel && !(provider === 'unknown' && backendModel === 'unknown')) {
        lines.push(`- Backend: **${provider} / ${backendModel}**`);
      }
    }
    if (a.error_message) {
      lines.push(`- Error: ${a.error_message}`);
    }
    lines.push('');

    if (a.status === 'completed') {
      lines.push(`#### Dimension Scores`);
      for (const dim of DIMENSIONS) {
        const d = a.dimension_scores[dim];
        if (!d) continue;
        lines.push(`- ${dimLabel(dim)}: **${d.score}/10**`);
        if (d.commentary) lines.push(`  - ${d.commentary}`);
      }
      lines.push('');

      if (a.top_issues.length > 0) {
        lines.push(`#### Top Issues`);
        a.top_issues.forEach((issue, idx) => {
          lines.push(`${idx + 1}. **${issue.issue || 'Issue'}**`);
          if (issue.specific_example_from_content) lines.push(`   - Example: "${issue.specific_example_from_content}"`);
          if (issue.suggested_rewrite) lines.push(`   - Suggested rewrite: "${issue.suggested_rewrite}"`);
        });
        lines.push('');
      }

      if (a.what_works_well.length > 0) {
        lines.push(`#### What Works Well`);
        for (const s of a.what_works_well) {
          lines.push(`- ${s}`);
        }
        lines.push('');
      }

      if (a.overall_verdict) {
        lines.push(`#### Overall Verdict`);
        lines.push(a.overall_verdict);
        lines.push('');
      }

      if (a.rewritten_headline) {
        lines.push(`#### Rewritten Headline Suggestion`);
        lines.push(`"${a.rewritten_headline}"`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportToCsv(model: ExportModel): string {
  const headers: string[] = [
    'session_id',
    'file_name',
    'session_status',
    'exported_at',
    'persona_id',
    'persona_name',
    'persona_role',
    'analysis_status',
    'analysis_provider',
    'analysis_model',
    ...DIMENSIONS.flatMap((d) => [`${d}_score`, `${d}_commentary`]),
    'top_issues_json',
    'what_works_well_json',
    'overall_verdict',
    'rewritten_headline',
    'error_message',
  ];

  const rows: string[] = [];
  rows.push(headers.map(csvCell).join(','));

  for (const a of model.analyses) {
    const row: string[] = [
      model.session.id,
      model.session.file_name,
      model.session.status,
      model.exported_at,
      a.persona_id,
      a.persona_name,
      a.persona_role,
      a.status,
      a.analysis_provider,
      a.analysis_model,
    ];

    for (const dim of DIMENSIONS) {
      const v = a.dimension_scores[dim];
      row.push(v ? String(v.score) : '');
      row.push(v ? v.commentary : '');
    }

    row.push(JSON.stringify(a.top_issues || []));
    row.push(JSON.stringify(a.what_works_well || []));
    row.push(a.overall_verdict || '');
    row.push(a.rewritten_headline || '');
    row.push(a.error_message || '');

    rows.push(row.map(csvCell).join(','));
  }

  return rows.join('\n');
}

function safeBaseFilename(name: string): string {
  return (name || 'roundtable')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'roundtable';
}

export function makeExportFilename(fileName: string, format: ExportFormat): string {
  const base = safeBaseFilename(fileName);
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base}.roundtable.${stamp}.${format}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function exportToPdfBlob(model: ExportModel): Promise<Blob> {
  // Dynamic import to keep the main bundle smaller.
  const pdfLib = await import('pdf-lib');
  const { PDFDocument, StandardFonts, rgb } = pdfLib;

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageSize: [number, number] = [612, 792]; // US Letter
  const margin = 48;
  const lineGap = 4;

  let page = pdfDoc.addPage(pageSize);
  let y = page.getHeight() - margin;

  const newPage = () => {
    page = pdfDoc.addPage(pageSize);
    y = page.getHeight() - margin;
  };

  const drawLines = (lines: string[], opts: { size: number; bold?: boolean; indent?: number } ) => {
    const size = opts.size;
    const usedFont = opts.bold ? fontBold : font;
    const indent = opts.indent || 0;
    const lineHeight = size + lineGap;
    for (const line of lines) {
      if (y < margin + lineHeight) newPage();
      page.drawText(line, {
        x: margin + indent,
        y,
        size,
        font: usedFont,
        color: rgb(0.1, 0.1, 0.1),
      });
      y -= lineHeight;
    }
  };

  const wrap = (text: string, usedFont: any, size: number, maxWidth: number): string[] => {
    const paragraphs = String(text || '').split(/\r?\n/);
    const out: string[] = [];

    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (!trimmed) {
        out.push('');
        continue;
      }

      const words = trimmed.split(/\s+/);
      let current = '';
      for (const w of words) {
        const next = current ? `${current} ${w}` : w;
        const width = usedFont.widthOfTextAtSize(next, size);
        if (width <= maxWidth) {
          current = next;
        } else {
          if (current) out.push(current);
          current = w;
        }
      }
      if (current) out.push(current);
    }

    return out;
  };

  const maxWidth = pageSize[0] - margin * 2;

  // Title
  drawLines([`Roundtable Export`], { size: 20, bold: true });
  y -= 6;
  drawLines([
    `Document: ${model.session.file_name}`,
    `Session: ${model.session.id}`,
    `Session status: ${model.session.status}`,
    `Analysis backend: ${model.analysis_backend.provider} / ${model.analysis_backend.model}`,
    `Exported at: ${model.exported_at}`,
  ], { size: 11 });
  y -= 10;

  // Executive Summary
  drawLines(['Executive Summary'], { size: 16, bold: true });
  y -= 4;
  drawLines([`Personas: ${model.stats.personas_total} (completed: ${model.stats.completed}, failed: ${model.stats.failed}, in progress: ${model.stats.pending_or_running})`], { size: 11 });
  y -= 6;

  drawLines(['Score Snapshot (Avg Across Completed Personas)'], { size: 12, bold: true });
  for (const dim of DIMENSIONS) {
    const v = model.dimension_averages[dim];
    const s = typeof v === 'number' ? `${v.toFixed(1)}/10` : 'N/A';
    drawLines([`${dimLabel(dim)}: ${s}`], { size: 11, indent: 12 });
  }
  y -= 6;

  if (model.common_themes.length > 0) {
    drawLines(['Common Themes'], { size: 12, bold: true });
    for (const t of model.common_themes) {
      const who = t.personas.length > 0 ? ` (${t.personas.join(', ')})` : '';
      const text = `• (${t.count} personas) ${t.label}${who}`;
      drawLines(wrap(text, font, 11, maxWidth), { size: 11 });
    }
    y -= 6;
  }

  if (model.common_strengths.length > 0) {
    drawLines(['Highlights'], { size: 12, bold: true });
    for (const t of model.common_strengths) {
      const who = t.personas.length > 0 ? ` (${t.personas.join(', ')})` : '';
      const text = `• (${t.count} personas) ${t.label}${who}`;
      drawLines(wrap(text, font, 11, maxWidth), { size: 11 });
    }
    y -= 6;
  }

  if (model.recommendations.length > 0) {
    drawLines(['Recommendations'], { size: 12, bold: true });
    for (const r of model.recommendations) {
      const text = `• ${r}`;
      drawLines(wrap(text, font, 11, maxWidth), { size: 11 });
    }
    y -= 10;
  }

  // Persona Details
  drawLines(['Persona Details'], { size: 16, bold: true });
  y -= 6;

  for (const a of model.analyses) {
    const heading = `${a.persona_name}${a.persona_role ? ` (${a.persona_role})` : ''}`;
    drawLines([heading], { size: 13, bold: true });
    drawLines([`Status: ${a.status}`], { size: 11 });
    {
      const provider = (a.analysis_provider || model.analysis_backend.provider || '').trim();
      const backendModel = (a.analysis_model || model.analysis_backend.model || '').trim();
      if (provider && backendModel && !(provider === 'unknown' && backendModel === 'unknown')) {
        drawLines([`Backend: ${provider} / ${backendModel}`], { size: 11 });
      }
    }
    if (a.error_message) {
      drawLines(wrap(`Error: ${a.error_message}`, font, 11, maxWidth), { size: 11 });
    }
    y -= 4;

    if (a.status === 'completed') {
      drawLines(['Dimension Scores'], { size: 11, bold: true });
      for (const dim of DIMENSIONS) {
        const d = a.dimension_scores[dim];
        if (!d) continue;
        drawLines([`${dimLabel(dim)}: ${d.score}/10`], { size: 11, indent: 12 });
        if (d.commentary) {
          drawLines(wrap(d.commentary, font, 10, maxWidth - 12), { size: 10, indent: 24 });
        }
      }
      y -= 4;

      if (a.top_issues.length > 0) {
        drawLines(['Top Issues'], { size: 11, bold: true });
        a.top_issues.forEach((issue, idx) => {
          const title = `${idx + 1}. ${issue.issue || 'Issue'}`;
          drawLines(wrap(title, fontBold, 11, maxWidth - 12), { size: 11, bold: true, indent: 12 });
          if (issue.specific_example_from_content) {
            drawLines(wrap(`Example: ${issue.specific_example_from_content}`, font, 10, maxWidth - 24), { size: 10, indent: 24 });
          }
          if (issue.suggested_rewrite) {
            drawLines(wrap(`Suggested rewrite: ${issue.suggested_rewrite}`, font, 10, maxWidth - 24), { size: 10, indent: 24 });
          }
        });
        y -= 4;
      }

      if (a.what_works_well.length > 0) {
        drawLines(['What Works Well'], { size: 11, bold: true });
        for (const s of a.what_works_well) {
          drawLines(wrap(`• ${s}`, font, 11, maxWidth - 12), { size: 11, indent: 12 });
        }
        y -= 4;
      }

      if (a.overall_verdict) {
        drawLines(['Overall Verdict'], { size: 11, bold: true });
        drawLines(wrap(a.overall_verdict, font, 11, maxWidth), { size: 11 });
        y -= 4;
      }

      if (a.rewritten_headline) {
        drawLines(['Rewritten Headline Suggestion'], { size: 11, bold: true });
        drawLines(wrap(`"${a.rewritten_headline}"`, font, 11, maxWidth), { size: 11 });
        y -= 4;
      }
    }

    y -= 10;
  }

  const bytes = await pdfDoc.save();
  // TS libdom types are picky about ArrayBufferLike vs ArrayBuffer, but pdf-lib returns an ArrayBuffer-backed Uint8Array.
  const buf = bytes.buffer as ArrayBuffer;
  const arrayBuffer = buf.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Blob([arrayBuffer], { type: 'application/pdf' });
}

export async function exportToDocxBlob(model: ExportModel): Promise<Blob> {
  // Dynamic import to keep the main bundle smaller.
  const docx = await import('docx');
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = docx as any;

  const children: any[] = [];

  const h = (text: string, level: any) => {
    children.push(new Paragraph({ text, heading: level }));
  };
  const p = (text: string) => {
    children.push(new Paragraph({ children: [new TextRun(String(text || ''))] }));
  };
  const bullet = (text: string) => {
    children.push(new Paragraph({ text: String(text || ''), bullet: { level: 0 } }));
  };

  h('Roundtable Export', HeadingLevel.TITLE);
  p(`Document: ${model.session.file_name}`);
  p(`Session: ${model.session.id}`);
  p(`Session status: ${model.session.status}`);
  p(`Analysis backend: ${model.analysis_backend.provider} / ${model.analysis_backend.model}`);
  p(`Exported at: ${model.exported_at}`);
  p('');

  h('Executive Summary', HeadingLevel.HEADING_1);
  h('Overview', HeadingLevel.HEADING_2);
  bullet(`Personas: ${model.stats.personas_total} (completed: ${model.stats.completed}, failed: ${model.stats.failed}, in progress: ${model.stats.pending_or_running})`);
  p('');

  h('Score Snapshot (Avg Across Completed Personas)', HeadingLevel.HEADING_2);
  for (const dim of DIMENSIONS) {
    const v = model.dimension_averages[dim];
    const s = typeof v === 'number' ? `${v.toFixed(1)}/10` : 'N/A';
    bullet(`${dimLabel(dim)}: ${s}`);
  }
  p('');

  if (model.common_themes.length > 0) {
    h('Common Themes', HeadingLevel.HEADING_2);
    for (const t of model.common_themes) {
      const who = t.personas.length > 0 ? ` (${t.personas.join(', ')})` : '';
      bullet(`(${t.count} personas) ${t.label}${who}`);
    }
    p('');
  }

  if (model.common_strengths.length > 0) {
    h('Highlights', HeadingLevel.HEADING_2);
    for (const t of model.common_strengths) {
      const who = t.personas.length > 0 ? ` (${t.personas.join(', ')})` : '';
      bullet(`(${t.count} personas) ${t.label}${who}`);
    }
    p('');
  }

  if (model.recommendations.length > 0) {
    h('Recommendations', HeadingLevel.HEADING_2);
    for (const r of model.recommendations) {
      bullet(r);
    }
    p('');
  }

  h('Persona Details', HeadingLevel.HEADING_1);
  for (const a of model.analyses) {
    h(`${a.persona_name}${a.persona_role ? ` (${a.persona_role})` : ''}`, HeadingLevel.HEADING_2);
    bullet(`Status: ${a.status}`);
    {
      const provider = (a.analysis_provider || model.analysis_backend.provider || '').trim();
      const backendModel = (a.analysis_model || model.analysis_backend.model || '').trim();
      if (provider && backendModel && !(provider === 'unknown' && backendModel === 'unknown')) {
        bullet(`Backend: ${provider} / ${backendModel}`);
      }
    }
    if (a.error_message) bullet(`Error: ${a.error_message}`);
    p('');

    if (a.status === 'completed') {
      h('Dimension Scores', HeadingLevel.HEADING_3);
      for (const dim of DIMENSIONS) {
        const d = a.dimension_scores[dim];
        if (!d) continue;
        bullet(`${dimLabel(dim)}: ${d.score}/10`);
        if (d.commentary) p(d.commentary);
      }
      p('');

      if (a.top_issues.length > 0) {
        h('Top Issues', HeadingLevel.HEADING_3);
        a.top_issues.forEach((issue, idx) => {
          bullet(`${idx + 1}. ${issue.issue || 'Issue'}`);
          if (issue.specific_example_from_content) p(`Example: ${issue.specific_example_from_content}`);
          if (issue.suggested_rewrite) p(`Suggested rewrite: ${issue.suggested_rewrite}`);
        });
        p('');
      }

      if (a.what_works_well.length > 0) {
        h('What Works Well', HeadingLevel.HEADING_3);
        for (const s of a.what_works_well) {
          bullet(s);
        }
        p('');
      }

      if (a.overall_verdict) {
        h('Overall Verdict', HeadingLevel.HEADING_3);
        p(a.overall_verdict);
        p('');
      }

      if (a.rewritten_headline) {
        h('Rewritten Headline Suggestion', HeadingLevel.HEADING_3);
        p(a.rewritten_headline);
        p('');
      }
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return await Packer.toBlob(doc);
}
