//! 4-layer memory: semantic / episodic / declarative / procedural.

pub mod declarative;
pub mod episodic;
pub mod error;
pub mod procedural;
pub mod semantic;

pub use error::MemoryError;
