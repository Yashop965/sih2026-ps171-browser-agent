## Task: Deployment and Packaging

**Assignee:** @Yashop965  
**Priority:** Medium  
**Due:** Day 4 (Sep 1)

### Requirements
- [ ] Create extension package (.zip for sideloading)
- [ ] Write installation guide
- [ ] Prepare demo environment script
- [ ] Create server Docker config (optional)

### Packaging Steps
```bash
# Build production extension
npm run build

# Package for sideloading
cd .output
zip -r sih2026-ps171-extension.zip chrome/
```

### Installation Guide Content
1. Download extension zip
2. Open Chrome → chrome://extensions/
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select extracted folder
6. Pin extension to toolbar
7. Open mock portal for testing

### Deliverables
- Extension package (`sih2026-ps171-extension.zip`)
- Installation guide (`docs/INSTALL.md`)
- Quick start script for demo day
