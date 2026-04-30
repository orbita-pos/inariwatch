//! Tauri-command shell for the saves summary. Impl in
//! [`crate::cloud::saves`].

use std::sync::Arc;

use crate::cloud::saves::{self, SavesSummary};
use crate::store::Store;

#[tauri::command]
pub async fn desktop_get_saves_summary(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<SavesSummary, String> {
    let store = state.inner().clone();
    saves::fetch_summary(&store).await
}
