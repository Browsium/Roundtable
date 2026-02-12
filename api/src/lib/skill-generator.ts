export interface PersonaProfile {
  id: string;
  name: string;
  role: string;
  background: string;
  professional_priorities: string[];
  marketing_pet_peeves: string[];
  evaluation_rubric: Record<string, string>;
  convince_me_criteria: string;
  voice_and_tone: string;
  typical_objections: string[];
  industry_influences: string;
  budget_authority: string;
}

export interface GeneratedSkill {
  skillName: string;
  manifest: string;
  template: string;
}

export function generateSkillFromPersona(
  persona: PersonaProfile,
  version: string = '1.0.0'
): GeneratedSkill {
  const skillName = `roundtable-${persona.id}-v${version}`;
  
  const manifest = generateManifest(persona, skillName, version);
  const template = generateTemplate(persona);
  
  return {
    skillName,
    manifest,
    template,
  };
}

function generateManifest(persona: PersonaProfile, skillName: string, version: string): string {
  return `name: ${skillName}
version: "${version}"
description: "${persona.name} - ${persona.role} evaluation"
provider: claude
model: sonnet
endpoints:
  - path: /roundtable/analyze/${persona.id}
    method: POST
    template: analyze.tmpl
    response_format: json
    timeout_seconds: 180
`;
}

function generateTemplate(persona: PersonaProfile): string {
  const personaJson = JSON.stringify(persona, null, 2);
  
  return `{{- $persona := \`${personaJson}\` -}}

{{- $document := .document_text -}}

{{- $prompt := printf \`
You are %s, a %s.

BACKGROUND:
%s

PROFESSIONAL PRIORITIES:
%s

MARKETING PET PEEVES:
%s

EVALUATION RUBRIC:
%s

CONVINCE ME CRITERIA:
%s

VOICE AND TONE:
%s

TYPICAL OBJECTIONS:
%s

INDUSTRY INFLUENCES:
%s

BUDGET AUTHORITY:
%s

DOCUMENT TO EVALUATE:
%%s

Please evaluate this marketing content from your perspective as a %s. Provide your analysis in JSON format with the following structure:

{
  "persona_role": "%s",
  "overall_score": <number 1-10>,
  "dimension_scores": {
    "relevance": {"score": <number>, "commentary": "<string>"},
    "technical_credibility": {"score": <number>, "commentary": "<string>"},
    "differentiation": {"score": <number>, "commentary": "<string>"},
    "actionability": {"score": <number>, "commentary": "<string>"},
    "trust_signals": {"score": <number>, "commentary": "<string>"},
    "language_fit": {"score": <number>, "commentary": "<string>"}
  },
  "top_3_issues": [
    {"issue": "<string>", "specific_example_from_content": "<string>", "suggested_rewrite": "<string>"}
  ],
  "what_works_well": ["<string>"],
  "overall_verdict": "<string>",
  "rewritten_headline_suggestion": "<string>"
}

Be honest and direct. Use your professional experience to provide actionable feedback.
\` $persona $document -}}

{{- $prompt -}}
`;
}

export function validateSkillName(skillName: string): boolean {
  // Pattern: roundtable-{persona_id}-v{major}.{minor}.{patch}
  const pattern = /^roundtable-[a-z0-9_]+-v\d+\.\d+\.\d+$/;
  return pattern.test(skillName);
}

export function generateNextVersion(currentVersion: string): string {
  const parts = currentVersion.split('.');
  const patch = parseInt(parts[2]) + 1;
  return `${parts[0]}.${parts[1]}.${patch}`;
}
