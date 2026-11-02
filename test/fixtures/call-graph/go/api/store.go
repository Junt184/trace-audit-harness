package api

type Store struct{}
type Other struct{}

func (Store) Save() { Finish() }
func (Other) Save() {}
func Finish() {}
