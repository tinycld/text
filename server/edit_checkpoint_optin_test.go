package text

import (
	"testing"

	"github.com/pocketbase/pocketbase"

	"tinycld.org/core/realtime"
)

// Drive makes automatic versions from editcheckpoint, which only rooms of a
// kind with EditCheckpoints fire.
func TestRealtime_TextRoomsFireEditCheckpoints(t *testing.T) {
	app := pocketbase.New()
	Register(app)

	opts, ok := realtime.LookupOptionsForTest(app, roomKindText)
	if !ok {
		t.Fatalf("Register did not register the %q room kind", roomKindText)
	}
	if !opts.EditCheckpoints {
		t.Fatal("text room kind does not fire edit checkpoints")
	}
}
