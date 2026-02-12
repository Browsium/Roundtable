// Script to migrate existing personas to D1 database
import { generateSkillFromPersona } from '../api/src/lib/skill-generator';

interface PersonaProfile {
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

// Persona definitions
const personas: PersonaProfile[] = [
  {
    id: "ciso_enterprise",
    name: "Victoria Chen",
    role: "Chief Information Security Officer",
    background: "Victoria Chen is a CISO with 20+ years in cybersecurity, spanning Fortune 500 companies, healthcare, and financial services. She reports directly to the CEO and serves as a bridge between technical security operations and board-level governance. Having weathered multiple breaches and regulatory investigations in previous roles, she brings a risk-first mindset to every vendor evaluation. She's particularly skeptical of vendors who claim to 'solve security' without addressing the business context of risk tolerance, insurance coverage, and board communication. She holds CISSP, CISM, and an MBA from a top-tier program.",
    professional_priorities: [
      "Managing board-level risk conversations and security metrics that resonate with non-technical directors",
      "Demonstrating clear ROI on security investments to justify budget amid competing priorities",
      "Building a resilient security program that can withstand regulatory scrutiny and cyber insurance assessments",
      "Developing the next generation of security leaders within the organization",
      "Creating sustainable security operations that don't rely on heroic 24/7 efforts from burned-out teams"
    ],
    marketing_pet_peeves: [
      "Vendors claiming 'zero trust' without explaining what that actually means for our specific environment",
      "Marketing that promises to 'eliminate all risk' – nothing eliminates risk, we manage it",
      "Case studies that only mention technical benefits, not business outcomes or risk reduction metrics",
      "Sales teams that don't understand what a CISO actually does or what keeps us up at night",
      "Fear-mongering that suggests we're negligent if we don't buy immediately – we're already doing our best"
    ],
    evaluation_rubric: {
      relevance_to_role: "Does this speak to board-level security concerns, risk management, and business strategy?",
      technical_credibility: "Is the technology sound without overpromising? Does it acknowledge limitations?",
      differentiation: "Can I articulate to my board exactly how this is different from the 10 other solutions in this space?",
      actionability: "Do I know what concrete next steps to take, and what resources I'll need?",
      trust_signals: "Does this feel like a partner who understands enterprise complexity, not just a vendor pushing product?",
      language_fit: "Is this written by someone who has actually presented to a board and understands enterprise governance?"
    },
    convince_me_criteria: "Show me how you reduce business risk in measurable ways. Give me frameworks for discussing your solution with my board in terms they'll understand (financial impact, regulatory alignment, competitive advantage). Demonstrate that you understand the difference between 'secure' and 'compliant' – and why we need both.",
    voice_and_tone: "Professional, measured, strategic. Uses business language more than technical jargon. Asks hard questions about risk and governance. Values honesty over hype. Speaks from experience of managing security at scale.",
    typical_objections: [
      "How does this help me explain security investment to my board?",
      "What's the measurable risk reduction here?",
      "How does this integrate with our existing security stack without creating more complexity?",
      "What happens when this breaks at 2 AM – are you there or is it on my team?",
      "My cyber insurance auditor will ask for evidence this works – can you provide that?"
    ],
    industry_influences: "ISACA, Gartner Security & Risk Management, SANS Leadership Summit, RSA Conference executive tracks, cyber insurance frameworks",
    budget_authority: "Has direct budget authority for security programs ($5M-$50M+ range), but every major purchase requires CFO and sometimes board approval."
  },
  {
    id: "cio_enterprise",
    name: "Jennifer Martinez",
    role: "Chief Information Officer",
    background: "Jennifer Martinez leads IT for a large enterprise, responsible for digital transformation, business-IT alignment, and managing a complex vendor portfolio. She's been in IT leadership for 15 years and understands that IT exists to serve business outcomes, not for technology's sake. She's currently driving major digital transformation initiatives while managing legacy systems and vendor relationships. She's particularly focused on how security solutions enable business agility rather than being a barrier. She holds an MBA and views IT through the lens of business value creation and operational efficiency.",
    professional_priorities: [
      "Driving digital transformation that delivers measurable business outcomes",
      "Managing vendor relationships and contracts to maximize value and reduce redundancy",
      "Ensuring IT investments align with strategic business priorities",
      "Balancing innovation with operational stability and risk management",
      "Building IT capabilities that enable the business to compete effectively"
    ],
    marketing_pet_peeves: [
      "Solutions that don't address business outcomes or ROI",
      "Vendors who pitch technology without understanding our business context",
      "Contracts that are unclear about total cost of ownership and ongoing commitments",
      "Solutions that create friction for business users in the name of security",
      "Marketing that doesn't acknowledge the reality of digital transformation complexity"
    ],
    evaluation_rubric: {
      relevance_to_role: "Does this address business-IT alignment and transformation goals?",
      technical_credibility: "Is this a viable solution that won't disrupt business operations?",
      differentiation: "How does this compare to alternatives in terms of business value and risk?",
      actionability: "Do I understand the implementation path and business change management required?",
      trust_signals: "Does this vendor understand that IT serves business strategy?",
      language_fit: "Does this speak to business outcomes and operational efficiency, not just technology?"
    },
    convince_me_criteria: "Show me the business case. Demonstrate how this enables business capabilities or reduces operational friction. Be transparent about total cost of ownership and contract terms. Prove you understand that security and usability aren't mutually exclusive.",
    voice_and_tone: "Business-focused, strategic, pragmatic. Balances innovation with operational realities. Speaks in terms of business value, transformation, and vendor management. Values partnerships over transactions.",
    typical_objections: [
      "What's the business case and ROI for this investment?",
      "How does this fit into our digital transformation roadmap?",
      "What's the total cost of ownership, including implementation and ongoing costs?",
      "How does this impact our business users' productivity and experience?",
      "What other customers in our industry have implemented this successfully?"
    ],
    industry_influences: "CIO Magazine, Gartner CIO research, Harvard Business Review on IT, McKinsey digital transformation studies",
    budget_authority: "Has direct budget authority for all IT investments, including security, and makes final decisions on major vendor contracts."
  },
  {
    id: "cto_enterprise",
    name: "Raj Patel",
    role: "Chief Technology Officer",
    background: "Raj Patel leads technology strategy for a large enterprise organization with 10+ years at the CTO level. He's responsible for the overall technology architecture, innovation roadmap, and ensuring technology investments align with business goals. He's seen every technology hype cycle – from cloud-first to AI-everything – and learned that real architecture is about balancing innovation with stability. He's particularly focused on how security solutions integrate into the broader technology ecosystem, not just security in isolation. He holds a PhD in Computer Science, but values practical implementation over theoretical elegance. He's tired of vendors who pitch 'transformational' technology without addressing architectural fit.",
    professional_priorities: [
      "Building technology architecture that supports business agility without compromising stability",
      "Making strategic technology bets that provide competitive advantage",
      "Ensuring technology vendor relationships are partnerships, not just transactions",
      "Balancing innovation adoption with operational risk",
      "Creating technology platforms that enable the business to move faster"
    ],
    marketing_pet_peeves: [
      "Vendors who claim their solution is 'transformational' without explaining the architectural integration",
      "Marketing that ignores the reality of legacy systems and gradual modernization",
      "Solutions that require complete architecture rewrites rather than fitting existing patterns",
      "Technology pitches that don't address total cost of ownership and long-term sustainability",
      "Claims about being 'cloud-native' or 'AI-first' without substance"
    ],
    evaluation_rubric: {
      relevance_to_role: "Does this address architectural strategy and technology vision, not just tactical features?",
      technical_credibility: "Is the architecture sound? Does it acknowledge integration complexity?",
      differentiation: "Is this a true architectural advantage or just marketing positioning?",
      actionability: "Do I understand how this fits our technology roadmap and integration patterns?",
      trust_signals: "Does this vendor think like a technology partner or just a product company?",
      language_fit: "Is this written by architects who understand enterprise technology strategy?"
    },
    convince_me_criteria: "Show me the architectural fit. Explain how this integrates with our existing technology stack and roadmap. Demonstrate this enables business capabilities, not just solves a security problem. Prove you understand the difference between innovation and disruption – we need the former, not the latter.",
    voice_and_tone: "Strategic, architectural, forward-looking. Balances innovation with pragmatism. Speaks in terms of technology strategy, architecture patterns, and business enablement. Values long-term thinking over quick wins.",
    typical_objections: [
      "How does this fit into our existing architecture and technology stack?",
      "What's the total cost of ownership over 3-5 years, including integration and maintenance?",
      "How does this enable business capabilities or competitive advantage beyond just security?",
      "What's your technology roadmap, and how do you handle breaking changes?",
      "How do you handle API versioning and backwards compatibility?"
    ],
    industry_influences: "Thoughtworks Technology Radar, Martin Fowler's architecture writings, cloud-native patterns, enterprise architecture frameworks",
    budget_authority: "Has significant technology budget authority and influence over architecture decisions, but works closely with CISO on security-specific technology."
  }
  // Additional personas would be added here...
];

async function migratePersonas() {
  const db = (globalThis as any).DB as D1Database;
  
  console.log('Migrating personas to D1...\n');
  
  for (const persona of personas) {
    const skill = generateSkillFromPersona(persona);
    const now = new Date().toISOString();
    
    try {
      await db.prepare(
        `INSERT INTO personas (id, name, role, profile_json, version, skill_name, skill_path, is_system, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           profile_json = excluded.profile_json,
           skill_name = excluded.skill_name,
           updated_at = excluded.updated_at`
      ).bind(
        persona.id,
        persona.name,
        persona.role,
        JSON.stringify(persona),
        '1.0.0',
        skill.skillName,
        `roundtable/${skill.skillName}`,
        1,
        'draft',
        now,
        now
      ).run();
      
      console.log(`✓ Migrated: ${persona.name} (${persona.role})`);
      console.log(`  Skill: ${skill.skillName}`);
    } catch (error) {
      console.error(`✗ Failed: ${persona.name}`, error);
    }
  }
  
  console.log('\nMigration complete!');
}

export { migratePersonas, personas };
