//! 世代バックアップと自動保存。
//!
//! 小説エディタでの原稿の喪失は取り返しがつかない。
//! 保存のたびに旧版を退避し、それとは別に一定間隔で自動保存する。

use std::fs;
use std::path::{Path, PathBuf};

/// 残す世代の数。
pub const GENERATIONS: usize = 5;

/// `原稿.txt` に対する `原稿.txt.bak1` のようなパスを作る。
fn backup_path(path: &Path, n: usize) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".bak{n}"));
    path.with_file_name(name)
}

/// 保存する直前に、既存のファイルを世代退避する。
///
/// bak5 を捨て、bak4→bak5、…、bak1→bak2 と押し出してから、
/// 現在のファイルを bak1 にする。ファイルがまだ無ければ何もしない。
pub fn rotate(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let oldest = backup_path(path, GENERATIONS);
    if oldest.exists() {
        fs::remove_file(&oldest).map_err(|e| format!("古いバックアップを消せません: {e}"))?;
    }
    for n in (1..GENERATIONS).rev() {
        let from = backup_path(path, n);
        if from.exists() {
            let to = backup_path(path, n + 1);
            fs::rename(&from, &to).map_err(|e| format!("バックアップを繰り上げられません: {e}"))?;
        }
    }
    fs::copy(path, backup_path(path, 1)).map_err(|e| format!("バックアップを作れません: {e}"))?;
    Ok(())
}

/// 自動保存の置き場所。開いているファイルの隣に置く。
///
/// まだ保存先が決まっていない新規の原稿は、呼び出し側が
/// アプリのデータ領域を渡すこと。
pub fn autosave_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".autosave");
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join("tate-editor-test").join(name);
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 世代が押し出される() {
        let dir = temp_dir("rotate");
        let path = dir.join("原稿.txt");

        // 5 回保存したことにして、そのたびに退避する
        for i in 1..=5 {
            fs::write(&path, format!("版{i}")).unwrap();
            rotate(&path).unwrap();
        }
        // rotate 直後は「今の内容」が bak1 に入っている
        assert_eq!(fs::read_to_string(backup_path(&path, 1)).unwrap(), "版5");
        assert_eq!(fs::read_to_string(backup_path(&path, 2)).unwrap(), "版4");
        assert_eq!(fs::read_to_string(backup_path(&path, 5)).unwrap(), "版1");

        // 6 回目で最古の版が捨てられる
        fs::write(&path, "版6").unwrap();
        rotate(&path).unwrap();
        assert_eq!(fs::read_to_string(backup_path(&path, 1)).unwrap(), "版6");
        assert_eq!(fs::read_to_string(backup_path(&path, 5)).unwrap(), "版2");
        assert!(!backup_path(&path, GENERATIONS + 1).exists());
    }

    #[test]
    fn ファイルが無ければ何もしない() {
        let dir = temp_dir("rotate-missing");
        let path = dir.join("まだ無い.txt");
        assert!(rotate(&path).is_ok());
        assert!(!backup_path(&path, 1).exists());
    }

    #[test]
    fn 自動保存のパスは隣に作られる() {
        let p = Path::new("C:/work/原稿.txt");
        assert_eq!(
            autosave_path(p).file_name().unwrap(),
            "原稿.txt.autosave"
        );
    }
}
