const fs = require('fs');
const path = require('path');

const personasDir = path.join(__dirname, '..', 'backend', 'personas');
const files = fs.readdirSync(personasDir).filter(f => f.endsWith('.json'));

let sql = '-- Generated persona insert statements\n\n';

files.forEach(file => {
  const content = fs.readFileSync(path.join(personasDir, file), 'utf-8');
  const persona = JSON.parse(content);
  
  const skillName = `roundtable-${persona.id}-v1.0.0`;
  const now = new Date().toISOString();
  const escapedProfile = JSON.stringify(persona).replace(/'/g, "''");
  
  const insert = `INSERT OR REPLACE INTO personas (id, name, role, profile_json, version, skill_name, skill_path, is_system, status, created_at, updated_at) 
VALUES ('${persona.id}', '${persona.name.replace(/'/g, "''")}', '${persona.role.replace(/'/g, "''")}', '${escapedProfile}', '1.0.0', '${skillName}', 'roundtable/${skillName}', 1, 'draft', '${now}', '${now}');

`;
  
  sql += insert;
});

sql += `\n-- Total personas: ${files.length}`;

fs.writeFileSync(path.join(__dirname, 'persona-inserts.sql'), sql);
console.log(`Generated persona-inserts.sql with ${files.length} personas`);
