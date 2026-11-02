package main

import repository "example.com/callgraph/api"

func entry() { repository.Store{}.Save() }
func main() { entry() }
