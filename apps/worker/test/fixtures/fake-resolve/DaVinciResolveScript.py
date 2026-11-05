# Stand-in for Blackmagic's DaVinciResolveScript module, so the bundled resolve_job.py can be run
# for real in tests. FAKE_RESOLVE: "ok" (default), "not-running", "bad-preset", "hang" (renders
# until stopped). It records the calls it gets in $FAKE_RESOLVE_LOG as JSON lines.
import json, os

MODE = os.environ.get("FAKE_RESOLVE", "ok")
LOG = os.environ.get("FAKE_RESOLVE_LOG")

def log(*call):
    if LOG:
        with open(LOG, "a") as f:
            f.write(json.dumps(list(call)) + "\n")

class Project:
    def __init__(self, name):
        self.name, self.settings, self.render, self.polls, self.stopped = name, {}, {}, 0, False
    def GetName(self): return self.name
    def SetSetting(self, k, v): log("SetSetting", k, v); return True
    def GetMediaPool(self): return MediaPool()
    def LoadRenderPreset(self, name): log("LoadRenderPreset", name); return MODE != "bad-preset"
    def SetRenderSettings(self, s): self.render = s; log("SetRenderSettings", s); return True
    def AddRenderJob(self): return "job-1"
    def StartRendering(self, job): log("StartRendering", job); return True
    def IsRenderingInProgress(self):
        if self.stopped: return False
        self.polls += 1
        if MODE == "hang": return True
        if self.polls > 2:
            out = os.path.join(self.render["TargetDir"], self.render["CustomName"] + ".mp4")
            with open(out, "w") as f: f.write("rendered")
            return False
        return True
    def GetRenderJobStatus(self, job):
        if self.stopped: return {"JobStatus": "Cancelled"}
        return {"JobStatus": "Complete" if self.polls > 2 else "Rendering", "CompletionPercentage": min(100, self.polls * 40)}
    def StopRendering(self): self.stopped = True; log("StopRendering")
    def DeleteRenderJob(self, job): log("DeleteRenderJob", job); return True

class MediaPool:
    def ImportMedia(self, paths): log("ImportMedia", [os.path.basename(p) for p in paths]); return ["item"] * len(paths)
    def CreateTimelineFromClips(self, name, items): log("CreateTimelineFromClips", name, len(items)); return object()

class ProjectManager:
    def __init__(self): self.current = Project("Dave's edit")
    def GetCurrentProject(self): return self.current
    def CreateProject(self, name): log("CreateProject", name); self.current = Project(name); return self.current
    def CloseProject(self, p): log("CloseProject", p.GetName()); return True
    def DeleteProject(self, name): log("DeleteProject", name); return True
    def LoadProject(self, name): log("LoadProject", name); return Project(name)

class Resolve:
    def GetProjectManager(self): return ProjectManager()

def scriptapp(name):
    return None if MODE == "not-running" else Resolve()
