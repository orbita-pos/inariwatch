//! Initial memory.md template content. Versioned via TEMPLATE_VERSION.

use std::path::Path;

pub const TEMPLATE_VERSION: u32 = 1;

pub fn render(repo_path: &Path) -> String {
    let project_blurb = sniff_readme_first_paragraph(repo_path)
        .unwrap_or_else(|| String::from("_TODO: describe what this repo is._"));

    format!(
        "# Inari Live memory\n\n\
         > Section markers control who can edit what:\n\
         > - [pinned] - humans only.\n\
         > - [auto-detected] - Inari maintains; humans can edit.\n\
         > - (no marker) - Inari proposes via review; you approve.\n\n\
         ## Project context [pinned]\n\n\
         {project_blurb}\n\n\
         ## Key decisions [pinned]\n\n\
         - _TODO: list architecture / framework / dependency choices._\n\n\
         ## Patterns learned by Inari [auto-detected]\n\n\
         _Populated by Inari (Session 12)._\n\n\
         ## Anti-patterns [auto-detected]\n\n\
         _Populated by Inari (Session 12)._\n\n\
         ## Glossary\n\n\
         _Domain-specific terms. Add as term - definition._\n\n\
         ## Inari config (managed) [auto-detected]\n\n\
         _Reserved for runtime knobs._\n"
    )
}

fn sniff_readme_first_paragraph(repo_path: &Path) -> Option<String> {
    let readme = repo_path.join("README.md");
    let bytes = std::fs::read(&readme).ok()?;
    let text = std::str::from_utf8(&bytes).ok()?;
    let mut paragraph = String::new();
    let mut started = false;
    for raw in text.lines() {
        let trimmed = raw.trim_end();
        if trimmed.is_empty() {
            if started { break; }
            continue;
        }
        if !started && trimmed.starts_with('#') { continue; }
        started = true;
        if !paragraph.is_empty() { paragraph.push('\n'); }
        paragraph.push_str(trimmed);
    }
    let p = paragraph.trim().to_string();
    if p.is_empty() { None } else { Some(p) }
}
