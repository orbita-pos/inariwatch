//! 4-layer memory: semantic / episodic / declarative / procedural.
//! `user_profile` adds the cross-session structured fact store (Jarvis layer).

pub mod declarative;
pub mod episodic;
pub mod error;
pub mod fingerprint;
pub mod procedural;
pub mod retention;
pub mod semantic;
pub mod user_profile;

pub use error::MemoryError;
