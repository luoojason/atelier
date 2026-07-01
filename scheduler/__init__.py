"""OpenSwarm always-on scheduler subsystem.

Standalone daemon that fires prompts at the OpenSwarm FastAPI agency on a
cadence. See scheduler/README.md. Pure logic lives in jobs_core.py and
client.py (framework-free, unit-testable); scheduler.py is the APScheduler
daemon.
"""
