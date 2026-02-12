# CLIBridge Requirements for Roundtable Integration

## Overview

This document outlines the minimal changes required to CLIBridge to support the Roundtable application. The goal is to enable skill upload via API endpoint while maintaining security and reliability.

## Changes Required

### 1. New Endpoint: Skill Upload

**Endpoint**: `POST /admin/skills/upload`

**Authentication**: CF Access (automatic for Cloudflare Workers)

**Request Format**:
```
Content-Type: multipart/form-data

Fields:
- skill_name: "roundtable-ciso-v1.0.0"
- manifest: (file content - YAML)
- template: (file content - Go template)
- template_name: "analyze.tmpl"
```

**Response Format**:
```json
{
  "success": true,
  "skill": "roundtable-ciso-v1.0.0",
  "path": "/opt/clibridge/skills/roundtable/roundtable-ciso-v1.0.0",
  "reloaded": true
}
```

**Validation Rules**:

1. **Skill Name Validation**
   - Regex: `^roundtable-[a-z0-9-]+-v\d+\.\d+\.\d+$`
   - Examples: 
     - ✅ `roundtable-ciso-v1.0.0`
     - ✅ `roundtable-devops-engineer-v2.1.3`
     - ❌ `../../../etc/passwd`
     - ❌ `roundtable-CISO-v1.0.0` (uppercase not allowed)

2. **Path Traversal Prevention**
   - Reject any skill name containing `..` or `/`
   - All skills created under: `{skills_dir}/roundtable/{skill_name}/`

3. **File Size Limits**
   - manifest.yaml: Max 10KB
   - template.tmpl: Max 100KB

4. **Content Validation**
   - manifest.yaml must be valid YAML
   - manifest must contain required fields: name, version, endpoints
   - template must be valid Go template syntax (compiles)
   - Template must not contain dangerous functions (exec, etc.)

**Processing Steps**:

1. Validate authentication (CF Access JWT)
2. Parse multipart form
3. Validate skill_name format
4. Validate file sizes
5. Parse manifest YAML
6. Validate manifest structure
7. Parse and validate template syntax
8. Create directory: `{skills_dir}/roundtable/{skill_name}/`
9. Write manifest.yaml
10. Write template file
11. Auto-reload skills (call existing Reload())
12. Return success response

**Error Responses**:

```json
// Invalid skill name
{
  "error": "Invalid skill name format",
  "details": "Must match pattern: roundtable-{id}-v{major}.{minor}.{patch}"
}

// Path traversal attempt
{
  "error": "Invalid skill name",
  "details": "Skill name contains invalid characters"
}

// File too large
{
  "error": "File too large",
  "details": "Template file exceeds 100KB limit"
}

// Invalid YAML
{
  "error": "Invalid manifest",
  "details": "YAML parse error: line 5: invalid syntax"
}

// Invalid template
{
  "error": "Invalid template",
  "details": "Template parse error: unexpected }}"
}

// Write failure
{
  "error": "Failed to write skill files",
  "details": "Permission denied: /opt/clibridge/skills/roundtable/..."
}
```

### 2. New Endpoint: Skill Cleanup

**Endpoint**: `POST /admin/skills/cleanup`

**Authentication**: CF Access

**Request Body**:
```json
{
  "skill_prefix": "roundtable-",
  "older_than_days": 60
}
```

**Response**:
```json
{
  "deleted": [
    "roundtable-ciso-v1.0.0",
    "roundtable-test-v0.9.0"
  ],
  "kept": [
    "roundtable-ciso-v1.0.1",
    "roundtable-cto-v1.0.0"
  ]
}
```

**Behavior**:
- Only deletes skills matching prefix
- Only deletes skills older than specified days
- Based on directory modification time
- Requires confirmation for production use

### 3. File System Structure

**Required Directory Layout**:

```
/opt/clibridge/
├── skills/
│   ├── _schema/                    # (existing)
│   ├── specomatic/                 # (existing)
│   └── roundtable/                 # (NEW - created on first upload)
│       ├── roundtable-ciso-v1.0.0/
│       │   ├── manifest.yaml
│       │   └── analyze.tmpl
│       ├── roundtable-cto-v1.0.0/
│       │   ├── manifest.yaml
│       │   └── analyze.tmpl
│       └── [other personas...]
```

**Permissions**:
- CLIBridge process must have write access to `skills/roundtable/`
- Directory should be created if it doesn't exist
- File permissions: 0644 for files, 0755 for directories

## Files to Modify

### 1. `internal/handler/admin.go`

**Add new routes to `ServeHTTP` method**:

```go
case r.Method == "POST" && path == "skills/upload":
    h.skillsUpload(w, r)
case r.Method == "POST" && path == "skills/cleanup":
    h.skillsCleanup(w, r)
```

**Add new handler methods**:
- `skillsUpload(w, r)` - Handle multipart upload
- `skillsCleanup(w, r)` - Handle cleanup request

### 2. `internal/handler/skills_upload.go` (NEW FILE)

**Structure**:
```go
package handler

import (
    // standard imports
)

type SkillsUploadHandler struct {
    skillsDir string
    engine    *skill.Engine
}

func NewSkillsUploadHandler(skillsDir string, engine *skill.Engine) *SkillsUploadHandler {
    return &SkillsUploadHandler{skillsDir: skillsDir, engine: engine}
}

func (h *SkillsUploadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Implementation
}

func (h *SkillsUploadHandler) validateSkillName(name string) error
func (h *SkillsUploadHandler) validateManifest(content []byte) error
func (h *SkillsUploadHandler) validateTemplate(content []byte) error
func (h *SkillsUploadHandler) createSkillDir(name string) error
func (h *SkillsUploadHandler) writeFiles(name string, manifest, template []byte) error
```

### 3. `internal/config/config.go`

**Add new fields**:

```go
type Config struct {
    // ... existing fields ...
    
    // Security settings
    Security SecurityConfig `yaml:"security"`
}

type SecurityConfig struct {
    MaxSkillSize    int64  `yaml:"max_skill_size"`    // default: 104857600 (100MB)
    MaxManifestSize int64  `yaml:"max_manifest_size"` // default: 10240 (10KB)
    RequireAuth     bool   `yaml:"require_auth"`      // default: true
}
```

## Security Requirements

### 1. Authentication
- **Method**: Cloudflare Access (JWT validation)
- **Header**: `CF-Access-Jwt-Assertion` or `CF-Access-Authenticated-User-Email`
- **Alternative**: Simple token for testing (if CF Access not available)

### 2. Path Traversal Prevention
```go
// Must implement
func sanitizeSkillName(name string) (string, error) {
    // Reject if contains: .. / \ $ ` ; | & < >
    // Must match: ^[a-z0-9-.]+$
    // Must start with: roundtable-
}
```

### 3. Content Validation

**Manifest Validation**:
- Must contain: name, version, description, provider, endpoints
- Provider must be one of: claude, codex, gemini, opencode, aider
- Endpoints must have: path, method, template

**Template Validation**:
```go
// Parse template
tmpl, err := template.New("validate").Parse(string(content))
if err != nil {
    return fmt.Errorf("template parse error: %w", err)
}

// Validate template functions (whitelist)
allowedFuncs := []string{
    "print", "printf", "println",
    "index", "len", "range",
    "if", "else", "end",
    "with", "template",
    "html", "js", "urlquery",
}
```

### 4. Rate Limiting
- Max 10 uploads per minute per IP
- Max 100 uploads per hour globally
- Implement via middleware or existing counting

## Testing Requirements

### Unit Tests

**Test cases to implement**:

1. **Valid upload**
   - Skill created successfully
   - Files written correctly
   - Auto-reload works

2. **Invalid skill name**
   - Rejects path traversal attempts
   - Rejects invalid characters
   - Rejects wrong prefix

3. **File size limits**
   - Rejects manifest > 10KB
   - Rejects template > 100KB
   - Accepts files at limit

4. **Content validation**
   - Rejects invalid YAML
   - Rejects invalid Go template
   - Rejects dangerous template functions

5. **Authentication**
   - Rejects without auth
   - Accepts with valid CF Access

6. **Cleanup**
   - Deletes old skills only
   - Preserves recent skills
   - Respects prefix filter

### Integration Tests

**Manual test commands**:

```bash
# Test valid upload
curl -X POST https://clibridge.badrobots.net/admin/skills/upload \
  -H "CF-Access-Authenticated-User-Email: test@example.com" \
  -F "skill_name=roundtable-test-v1.0.0" \
  -F "manifest=@test-manifest.yaml" \
  -F "template=@test-template.tmpl" \
  -F "template_name=analyze.tmpl"

# Test invalid name
curl -X POST https://clibridge.badrobots.net/admin/skills/upload \
  -H "CF-Access-Authenticated-User-Email: test@example.com" \
  -F "skill_name=../../../etc/passwd" \
  -F "manifest=@test-manifest.yaml" \
  -F "template=@test-template.tmpl" \
  -F "template_name=analyze.tmpl"

# Test cleanup
curl -X POST https://clibridge.badrobots.net/admin/skills/cleanup \
  -H "CF-Access-Authenticated-User-Email: test@example.com" \
  -H "Content-Type: application/json" \
  -d '{"skill_prefix":"roundtable-","older_than_days":60}'

# Verify skill works
curl -X POST https://clibridge.badrobots.net/roundtable/analyze/test \
  -H "Content-Type: application/json" \
  -d '{"document_text":"Test content"}'
```

## Configuration Example

**`config/clibridge.yaml`**:

```yaml
port: 8080
log_level: info
data_dir: /data
skills_dir: skills

providers:
  default_provider: claude
  default_model: sonnet
  timeout_seconds: 120
  claude:
    enabled: true
    binary: claude
    model: sonnet
  # ... other providers ...

security:
  max_skill_size: 104857600      # 100MB
  max_manifest_size: 10240       # 10KB
  require_auth: true
```

## Deployment Steps

1. **Backup existing CLIBridge**
   ```bash
   # On OracleVM
   sudo systemctl stop clibridge
   sudo cp -r /opt/clibridge /opt/clibridge-backup-$(date +%Y%m%d)
   ```

2. **Update code**
   - Add new files
   - Modify existing files
   - Update config

3. **Create directory structure**
   ```bash
   sudo mkdir -p /opt/clibridge/skills/roundtable
   sudo chown -R clibridge:clibridge /opt/clibridge/skills/roundtable
   ```

4. **Build and deploy**
   ```bash
   docker build -t clibridge:latest .
   docker stop clibridge
   docker run -d --name clibridge \
     -v /opt/clibridge/data:/data \
     -v /opt/clibridge/skills:/app/skills \
     -p 8080:8080 \
     clibridge:latest
   ```

5. **Verify**
   ```bash
   curl https://clibridge.badrobots.net/health
   curl https://clibridge.badrobots.net/admin/skills
   ```

## Rollback Plan

If deployment fails:

1. Stop new container
2. Restore from backup
3. Start previous version
4. Investigate and fix issues

## Success Criteria

- [ ] Upload endpoint accepts valid skills
- [ ] Upload endpoint rejects invalid skills with clear errors
- [ ] Auto-reload works after upload
- [ ] Cleanup endpoint works
- [ ] All existing endpoints continue working
- [ ] Skills execute correctly after upload
- [ ] Security validation prevents attacks

## Questions

1. Should we add a test endpoint for manual testing without CF Access?
   - Option A: Yes, with simple token auth
   - Option B: No, CF Access only

2. Should we support multiple templates per skill?
   - Option A: Yes (e.g., analyze.tmpl, summary.tmpl)
   - Option B: No, one template per skill

3. Should we add a "dry-run" upload option?
   - Option A: Yes, validate but don't write
   - Option B: No, just upload and see

---

**Document Status**: Draft  
**Last Updated**: 2025-02-11  
**Ready for Implementation**: Pending approval
