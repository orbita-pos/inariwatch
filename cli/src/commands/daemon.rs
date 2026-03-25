use anyhow::{Context, Result};
use colored::Colorize;
use std::path::PathBuf;

// ── Platform helpers ──────────────────────────────────────────────────────────

fn log_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".inariwatch")
        .join("daemon.log")
}

fn bin_path() -> Result<PathBuf> {
    std::env::current_exe().context("Cannot determine binary path")
}

// ── Linux — systemd user service ─────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    const UNIT: &str = "inariwatch.service";

    fn unit_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from(".config"))
            .join("systemd/user")
            .join(UNIT)
    }

    pub fn install() -> Result<()> {
        let bin = bin_path()?;
        let log = log_path();
        std::fs::create_dir_all(log.parent().context("invalid log path")?)?;

        let unit = format!(
            "[Unit]\n\
             Description=InariWatch AI monitoring daemon\n\
             After=network-online.target\n\
             Wants=network-online.target\n\
             \n\
             [Service]\n\
             Type=simple\n\
             ExecStart={bin}\n\
             Restart=on-failure\n\
             RestartSec=30\n\
             StandardOutput=append:{log}\n\
             StandardError=append:{log}\n\
             \n\
             [Install]\n\
             WantedBy=default.target\n",
            bin = bin.display(),
            log = log.display(),
        );

        let path = unit_path();
        std::fs::create_dir_all(path.parent().context("invalid path")?)?;
        std::fs::write(&path, unit)?;

        std::process::Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .status()?;
        std::process::Command::new("systemctl")
            .args(["--user", "enable", UNIT])
            .status()?;

        println!("{} Daemon installed (systemd user service).", "✓".green());
        println!("  Run {} to start it now.", "inariwatch daemon start".cyan());
        println!("  Logs: {}", log.display().to_string().dimmed());
        Ok(())
    }

    pub fn uninstall() -> Result<()> {
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "stop", UNIT])
            .status();
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "disable", UNIT])
            .status();
        let _ = std::fs::remove_file(unit_path());
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .status();
        println!("{} Daemon removed.", "✓".green());
        Ok(())
    }

    pub fn start() -> Result<()> {
        std::process::Command::new("systemctl")
            .args(["--user", "start", UNIT])
            .status()?;
        println!("{} Daemon started.", "✓".green());
        Ok(())
    }

    pub fn stop() -> Result<()> {
        std::process::Command::new("systemctl")
            .args(["--user", "stop", UNIT])
            .status()?;
        println!("{} Daemon stopped.", "✓".green());
        Ok(())
    }

    pub fn status() -> Result<()> {
        std::process::Command::new("systemctl")
            .args(["--user", "status", UNIT])
            .status()?;
        Ok(())
    }
}

// ── macOS — launchd agent ─────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    const LABEL: &str = "com.inariwatch.daemon";

    fn plist_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", LABEL))
    }

    pub fn install() -> Result<()> {
        let bin = bin_path()?;
        let log = log_path();
        std::fs::create_dir_all(log.parent().context("invalid log path")?)?;

        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
             \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n\
             <dict>\n\
               <key>Label</key>\n\
               <string>{label}</string>\n\
               <key>ProgramArguments</key>\n\
               <array>\n\
                 <string>{bin}</string>\n\
                 <string>watch</string>\n\
               </array>\n\
               <key>RunAtLoad</key>\n\
               <true/>\n\
               <key>KeepAlive</key>\n\
               <true/>\n\
               <key>StandardOutPath</key>\n\
               <string>{log}</string>\n\
               <key>StandardErrorPath</key>\n\
               <string>{log}</string>\n\
             </dict>\n\
             </plist>\n",
            label = LABEL,
            bin = bin.display(),
            log = log.display(),
        );

        let path = plist_path();
        std::fs::create_dir_all(path.parent().context("invalid path")?)?;
        std::fs::write(&path, plist)?;

        std::process::Command::new("launchctl")
            .args(["load", "-w", &path.to_string_lossy()])
            .status()?;

        println!("{} Daemon installed (launchd agent).", "✓".green());
        println!("  Starts automatically at login.");
        println!("  Logs: {}", log.display().to_string().dimmed());
        Ok(())
    }

    pub fn uninstall() -> Result<()> {
        let path = plist_path();
        if path.exists() {
            let _ = std::process::Command::new("launchctl")
                .args(["unload", "-w", &path.to_string_lossy()])
                .status();
            std::fs::remove_file(&path)?;
        }
        println!("{} Daemon removed.", "✓".green());
        Ok(())
    }

    pub fn start() -> Result<()> {
        std::process::Command::new("launchctl")
            .args(["start", LABEL])
            .status()?;
        println!("{} Daemon started.", "✓".green());
        Ok(())
    }

    pub fn stop() -> Result<()> {
        std::process::Command::new("launchctl")
            .args(["stop", LABEL])
            .status()?;
        println!("{} Daemon stopped.", "✓".green());
        Ok(())
    }

    pub fn status() -> Result<()> {
        let out = std::process::Command::new("launchctl")
            .args(["list", LABEL])
            .output()?;
        print!("{}", String::from_utf8_lossy(&out.stdout));
        Ok(())
    }
}

// ── Windows — Task Scheduler ──────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    const TASK: &str = "InariWatch\\Watch";

    pub fn install() -> Result<()> {
        let bin = bin_path()?;
        let log = log_path();
        std::fs::create_dir_all(log.parent().context("invalid log path")?)?;

        // Create task: run at logon, highest privileges, restart on failure
        let status = std::process::Command::new("schtasks")
            .args([
                "/Create",
                "/TN", TASK,
                "/TR", &format!("\"{}\" watch", bin.display()),
                "/SC", "ONLOGON",
                "/RL", "HIGHEST",
                "/F",  // overwrite if exists
            ])
            .status()?;

        if !status.success() {
            anyhow::bail!("schtasks failed — try running as administrator");
        }

        println!("{} Daemon installed (Task Scheduler).", "✓".green());
        println!("  Starts automatically at Windows login.");
        println!("  Run {} to start it now.", "inariwatch daemon start".cyan());
        println!("  Logs: {}", log.display().to_string().dimmed());
        Ok(())
    }

    pub fn uninstall() -> Result<()> {
        let _ = std::process::Command::new("schtasks")
            .args(["/End", "/TN", TASK])
            .status();
        std::process::Command::new("schtasks")
            .args(["/Delete", "/TN", TASK, "/F"])
            .status()?;
        println!("{} Daemon removed.", "✓".green());
        Ok(())
    }

    pub fn start() -> Result<()> {
        std::process::Command::new("schtasks")
            .args(["/Run", "/TN", TASK])
            .status()?;
        println!("{} Daemon started.", "✓".green());
        Ok(())
    }

    pub fn stop() -> Result<()> {
        std::process::Command::new("schtasks")
            .args(["/End", "/TN", TASK])
            .status()?;
        println!("{} Daemon stopped.", "✓".green());
        Ok(())
    }

    pub fn status() -> Result<()> {
        let out = std::process::Command::new("schtasks")
            .args(["/Query", "/TN", TASK, "/FO", "LIST"])
            .output()?;
        print!("{}", String::from_utf8_lossy(&out.stdout));
        Ok(())
    }
}

// ── Public entry point ────────────────────────────────────────────────────────

pub async fn run(action: &str) -> Result<()> {
    match action {
        "install"   => platform::install(),
        "uninstall" => platform::uninstall(),
        "start"     => platform::start(),
        "stop"      => platform::stop(),
        "status"    => platform::status(),
        other => {
            println!("{} Unknown action: {}", "✗".red(), other);
            println!("  Usage: inariwatch daemon <install|uninstall|start|stop|status>");
            Ok(())
        }
    }
}
