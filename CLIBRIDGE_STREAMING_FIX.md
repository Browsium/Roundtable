# CLIBridge Streaming Endpoint Fix

## Problem Identified

The CLIBridge streaming endpoint (`/v1/stream`) was returning HTTP 200 with `Content-Type: text/event-stream` but `Content-Length: 0`, resulting in empty responses. Meanwhile, the complete endpoint (`/v1/complete`) worked correctly.

## Root Cause

After extensive investigation, the root cause was identified in the CLIBridge codebase:

1. **Missing Required Flag**: The Claude CLI requires the `--verbose` flag when using `--output-format stream-json`, but CLIBridge was not passing this flag.

2. **CLI Behavior Difference**: 
   - `claude --output-format json -p -` works correctly
   - `claude --output-format stream-json -p -` fails with error: "When using --print, --output-format=stream-json requires --verbose"
   - `claude --output-format stream-json --verbose -p -` works correctly

## Solution Implemented

Modified `internal/provider/claude.go` in the CLIBridge repo (path will vary by machine) in the `buildStreamArgs` function to include the `--verbose` flag:

```go
func (p *claudeProvider) buildStreamArgs(req CompletionRequest, prompt string) []string {
    // Added --verbose flag to fix streaming issue
    args := []string{"-p", prompt, "--output-format", "stream-json", "--verbose", "--no-session-persistence"}
    
    // ... rest of the function unchanged
}
```

## Testing Verification

Direct testing of the Claude CLI confirmed the issue and solution:
```bash
# This fails (what CLIBridge was doing):
echo '{"messages":[{"role":"user","content":"Hello"}]}' | claude --output-format stream-json -p -

# This works (what CLIBridge should be doing):
echo '{"messages":[{"role":"user","content":"Hello"}]}' | claude --output-format stream-json --verbose -p -
```

## Next Steps

1. **Rebuild CLIBridge**: The modified code needs to be compiled into a new binary
2. **Deploy Updated Service**: Replace the running CLIBridge instance with the fixed version
3. **Test Integration**: Verify that Roundtable's document analysis streaming works correctly

## Impact

This fix should resolve the "No response received" issue in Roundtable's document analysis feature, allowing proper streaming of Claude's responses instead of empty responses.
