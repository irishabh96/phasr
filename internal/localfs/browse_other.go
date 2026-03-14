//go:build !darwin

package localfs

import "fmt"

func BrowseDirectory() (string, error) {
	return "", fmt.Errorf("browse directory is supported only on macOS desktop runtime")
}
