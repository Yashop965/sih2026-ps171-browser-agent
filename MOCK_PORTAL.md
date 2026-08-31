# Mock Government Portal — Test Data & Documentation

## Overview
This mock portal simulates an Indian government Aadhaar enrollment form for testing the browser agent's privacy features and automation capabilities.

---

## File Location
```
public/mock-form.html
```

---

## Form Fields & PII Types

### Personal Information
| Field ID | Field Name | Type | Sample Data | PII Category |
|----------|-----------|------|-------------|--------------|
| `firstName` | First Name | text | "Rajesh" | Name (low sensitivity) |
| `lastName` | Last Name | text | "Sharma" | Name (low sensitivity) |
| `fullName` | Full Name | text | "Rajesh Kumar Sharma" | Name (medium sensitivity) |

### Identification Details
| Field ID | Field Name | Type | Sample Data | PII Category |
|----------|-----------|------|-------------|--------------|
| `aadhaar` | Aadhaar Number | text | "1234 5678 9012" | **High** - Government ID |
| `pan` | PAN Number | text | "ABCDE1234F" | **High** - Tax ID |
| `mobile` | Mobile Number | tel | "+91 9876543210" | **High** - Contact |
| `email` | Email Address | email | "rajesh@example.com" | Medium - Contact |

### Address Details
| Field ID | Field Name | Type | Sample Data | PII Category |
|----------|-----------|------|-------------|--------------|
| `address` | Permanent Address | textarea | "123, MG Road, Sector 5" | Medium - Location |
| `city` | City | text | "New Delhi" | Low - Location |
| `pincode` | Pin Code | text | "110001" | Low - Location |
| `state` | State | select | "Delhi" | Low - Location |
| `country` | Country | select | "India" | Low - Location |

### Security Settings
| Field ID | Field Name | Type | Sample Data | PII Category |
|----------|-----------|------|-------------|--------------|
| `password` | Password | password | "Test@123" | **Critical** - Credential |
| `confirmPassword` | Confirm Password | password | "Test@123" | **Critical** - Credential |
| `securityQuestion` | Security Question | select | "motherMaidenName" | Medium - Auth |
| `securityAnswer` | Security Answer | text | "Sharma" | Medium - Auth |

---

## Test Scenarios

### Scenario 1: PII Detection Test
**Goal:** Verify all PII types are detected correctly

**Steps:**
1. Open `public/mock-form.html` in Chrome/Firefox
2. Load the extension
3. Fill in all fields with sample data
4. Watch console for PII detection logs
5. Check Privacy Ledger for entries

**Expected Detections:**
- Aadhaar: 12-digit number detected
- PAN: Format validated (5 letters + 4 digits + 1 letter)
- Mobile: 10-digit phone number detected
- Email: Valid email format detected
- Password: Password field identified (value NOT read)

---

### Scenario 2: Automation Test
**Goal:** Test autonomous form filling

**Steps:**
1. Open the mock form
2. Click extension icon
3. Enter task: "Fill all fields with test data and submit"
4. Observe action execution
5. Verify Privacy Ledger entries

**Expected Behavior:**
- Each field gets correct test data
- Form validates successfully
- Submission confirmation appears
- All actions logged in ledger

---

### Scenario 3: Privacy Verification Test
**Goal:** Verify no PII leaks to server

**Steps:**
1. Open browser DevTools → Network tab
2. Fill and submit form
3. Check network requests
4. Export Privacy Ledger as JSON

**Expected Results:**
- No network requests to external servers
- Form submission is local only
- Ledger shows all redactions
- Export contains no raw PII values

---

## Validation Rules

### Aadhaar Number
- Format: 12 digits with optional spaces
- Regex: `\d{4}\s?\d{4}\s?\d{4}`
- Auto-formats with spaces as user types

### PAN Number
- Format: 5 letters + 4 digits + 1 letter
- Regex: `[A-Z]{5}\d{4}[A-Z]{1}`
- Auto-converts to uppercase

### Mobile Number
- Format: +91 followed by 10 digits
- Regex: `\+91\s?\d{10}`
- Auto-adds +91 prefix

### Pin Code
- Format: 6 digits
- Regex: `\d{6}`

### Password
- Minimum 8 characters
- Must match confirm password
- Stored as password type (value not exposed)

---

## Browser Compatibility

| Browser | Status | Notes |
|---------|--------|-------|
| Chrome | ✅ Tested | Full functionality |
| Firefox | ✅ Tested | Full functionality |
| Edge | ✅ Compatible | Based on Chromium |
| Safari | ⚠️ Partial | Modern browsers only |

---

## Integration with Extension

### Content Script Injection
The mock form is designed to work with the browser extension's content script:

```javascript
// Content script will detect:
- Input fields with types: text, email, tel, password
- Select dropdowns
- Textarea elements
- Form submission buttons
```

### Expected Messages
```javascript
// Extension sends:
{ type: 'EXTRACT' } → Gets DOM snapshot
{ type: 'EXECUTE', action: {...} } → Performs action

// Extension receives:
{ type: 'DOM_EXTRACT', payload: {...} }
{ type: 'PII_DETECTED', payload: {...} }
```

---

## Styling Notes

The form uses:
- Gradient backgrounds (purple/blue theme)
- Clean card-based layout
- Responsive design (works on mobile)
- Real-time validation feedback
- Error states with red highlighting
- Success states with green alerts

---

## Demo Script for Judges

1. **Open the portal** — Show the mock government form
2. **Fill manually** — Enter test data to show PII fields
3. **Show detection** — Open console to show real-time PII detection
4. **Run automation** — Use extension to auto-fill form
5. **Show ledger** — Display Privacy Ledger with all entries
6. **Export ledger** — Download signed JSON for verification
7. **Verify integrity** — Show SHA-256 hash matches

---

## Files

- `public/mock-form.html` — Main form (1 HTML file)
- No external dependencies
- Self-contained CSS and JavaScript
- Ready to open in any browser

---

## Next Steps

1. Open `public/mock-form.html` in browser
2. Load extension in dev mode
3. Test with sample data
4. Record demo video
5. Show to judges
