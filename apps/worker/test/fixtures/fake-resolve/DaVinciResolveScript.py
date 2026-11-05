# Stand-in for Blackmagic's DaVinciResolveScript module, so the bundled resolve_job.py can be run
# for real in tests. FAKE_RESOLVE: "ok" (default), "not-running", "bad-preset", "hang" (renders
# until stopped). FAKE_RESOLVE_EXISTING: JSON {project: [timeline names]} of projects already in
# Resolve, besides "Dave's edit", which is open. Calls are recorded in $FAKE_RESOLVE_LOG as JSON lines.
import json, os

MODE = os.environ.get("FAKE_RESOLVE", "ok")
LOG = os.environ.get("FAKE_RESOLVE_LOG")
EXISTING = json.loads(os.environ.get("FAKE_RESOLVE_EXISTING", "{}"))

def log(*call):
    if LOG:
        with open(LOG, "a") as f:
            f.write(json.dumps(list(call)) + "\n")

class Timeline:
    def __init__(self, name, clips=0):
        self.name, self.clips = name, clips
    def GetName(self): return self.name

class Project:
    def __init__(self, name, timelines=()):
        self.name, self.render, self.polls, self.stopped = name, {}, 0, False
        self.timelines = [Timeline(t, 1) for t in timelines]
        self.current = self.timelines[0] if self.timelines else None
    def GetName(self): return self.name
    def SetSetting(self, k, v): log("SetSetting", k, v); return True
    def GetMediaPool(self): return MediaPool(self)
    def GetTimelineCount(self): return len(self.timelines)
    def GetTimelineByIndex(self, i): return self.timelines[i - 1]
    def SetCurrentTimeline(self, tl): self.current = tl; log("SetCurrentTimeline", tl.name); return True
    def LoadRenderPreset(self, name): log("LoadRenderPreset", name); return MODE != "bad-preset"
    def SetRenderSettings(self, s): self.render = s; log("SetRenderSettings", s); return True
    def AddRenderJob(self): return "job-1"
    def StartRendering(self, job): log("StartRendering", job, self.current.name, self.current.clips); return True
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
    def __init__(self, project): self.project = project
    def ImportMedia(self, paths): log("ImportMedia", [os.path.basename(p) for p in paths]); return ["item"] * len(paths)
    def CreateTimelineFromClips(self, name, items):
        log("CreateTimelineFromClips", name, len(items))
        tl = Timeline(name, len(items))
        self.project.timelines.append(tl)
        self.project.current = tl
        return tl
    def AppendToTimeline(self, items):
        log("AppendToTimeline", self.project.current.name, len(items))
        self.project.current.clips += len(items)
        return ["timeline-item"] * len(items)

class ProjectManager:
    def __init__(self):
        self.projects = {"Dave's edit": ["Main"], **EXISTING}
        self.current = Project("Dave's edit", ["Main"])
    def GetCurrentProject(self): return self.current
    def CreateProject(self, name):
        log("CreateProject", name)
        if name in self.projects: return None
        self.projects[name] = []
        self.current = Project(name)
        return self.current
    def LoadProject(self, name):
        log("LoadProject", name)
        if name not in self.projects: return None
        self.current = Project(name, self.projects[name])
        return self.current
    def SaveProject(self): log("SaveProject", self.current.name); return True
    def CloseProject(self, p): log("CloseProject", p.GetName()); return True
    def DeleteProject(self, name): log("DeleteProject", name); self.projects.pop(name, None); return True

class Resolve:
    def GetProjectManager(self): return ProjectManager()

def scriptapp(name):
    return None if MODE == "not-running" else Resolve()
