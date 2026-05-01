//! LSP method handlers. Split per-method to keep each file under ~100
//! LoC and to localise the TODO markers Sesión 23 / 24 / 25 / 26 will
//! flip when the local-AI loop lands.

pub mod cancel;
pub mod code_action;
pub mod completion;
pub mod hover;
pub mod initialize;
