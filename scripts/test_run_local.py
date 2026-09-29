"""Focused safety checks for the Windows local launcher."""

import unittest
from unittest.mock import patch

import run_local


class CloudModeTests(unittest.TestCase):
    def test_reads_the_deployed_https_origin(self) -> None:
        origin = run_local.cloud_api_origin()
        self.assertTrue(origin.startswith("https://"))
        self.assertFalse(origin.endswith("/"))

    def test_refuses_a_plain_http_origin(self) -> None:
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as folder:
            env_file = Path(folder) / ".env.production"
            env_file.write_text("MAIN_VITE_API_BASE_URL=http://example.test\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                run_local.cloud_api_origin(env_file)


class PortSelectionTests(unittest.TestCase):
    def test_unrelated_listener_is_never_selected_for_termination(self) -> None:
        with patch.object(
            run_local,
            "process_details",
            side_effect=lambda pid: (0, "python -m http.server 8080"),
        ):
            self.assertIsNone(run_local.workspace_process(123, 8080))

    def test_workspace_api_watcher_is_stopped_instead_of_its_child(self) -> None:
        process_tree = {
            123: (456, f"node {run_local.ROOT}\\node_modules\\tsx src/server.ts"),
            456: (0, f"node {run_local.ROOT}\\node_modules\\tsx watch src/server.ts"),
        }
        with patch.object(
            run_local, "process_details", side_effect=process_tree.get
        ):
            self.assertEqual(run_local.workspace_process(123, 8080), 456)

    def test_busy_port_moves_to_next_free_port(self) -> None:
        with patch.object(
            run_local, "port_in_use", side_effect=lambda port: port == 8080
        ):
            self.assertEqual(run_local.free_port(8080), 8081)

    def test_api_origin_and_desktop_match_selected_port(self) -> None:
        runtime = run_local.local_environment(
            {"owner_password": "owner-password", "app_password": "app-password"},
            8085,
        )
        desktop = run_local.desktop_environment(runtime)
        self.assertEqual(runtime["PUBLIC_BASE_URL"], "http://127.0.0.1:8085")
        self.assertEqual(desktop["MAIN_VITE_API_BASE_URL"], runtime["PUBLIC_BASE_URL"])
        self.assertNotIn("DB_PASSWORD", desktop)
        self.assertNotIn("SWYFT_OWNER_PASSWORD", runtime)


if __name__ == "__main__":
    unittest.main()
