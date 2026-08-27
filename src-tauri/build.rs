fn main() {
  tauri_build::build();
  // admin-web/dist 编译进二进制（include_dir），前端改动需触发重编
  println!("cargo:rerun-if-changed=../admin-web/dist");
}
