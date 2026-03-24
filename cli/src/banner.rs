use colored::Colorize;
use std::io::Write;
use tokio::time::{sleep, Duration};

/// Print animated InariWatch banner with dots.
pub async fn print_banner() {
    let dot_steps: &[&str] = &["·", "· ·", "· · ·", "· · · ·", "· · · · ·"];
    let dot_color = |s: &str| s.truecolor(99, 102, 241).to_string(); // indigo

    // Dots growing in
    for step in dot_steps {
        print!("\r  {}", dot_color(step));
        let _ = std::io::stdout().flush();
        sleep(Duration::from_millis(60)).await;
    }
    println!();

    // Logo line — typewriter
    let logo = "INARIWATCH";
    print!("  ");
    for ch in logo.chars() {
        print!("{}", ch.to_string().bold().bright_white());
        let _ = std::io::stdout().flush();
        sleep(Duration::from_millis(45)).await;
    }
    println!();

    // Dots shrinking out
    for step in dot_steps.iter().rev() {
        print!("\r  {}", dot_color(step));
        let _ = std::io::stdout().flush();
        sleep(Duration::from_millis(50)).await;
    }
    print!("\r  {}", dot_color("·"));
    let _ = std::io::stdout().flush();
    sleep(Duration::from_millis(120)).await;
    // Clear the dot line
    print!("\r  {:<20}\r", "");
    let _ = std::io::stdout().flush();

    println!();
}
